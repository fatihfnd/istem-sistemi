// daily-backup — pg_cron tarafından her gece tetiklenir (bkz. yedekler_sema.sql).
// 1) istemler + istem_kalemleri + istem_log + istem_notlari (+ ad çözmek için
//    istem_kuyruk_v, kullanicilar, test_gruplari) service_role ile (RLS'yi
//    atlayarak) TAM okunur.
// 2) Okunabilir sayfalar (ID yerine ad) + ham sayfalar içeren .xlsx üretilir
//    (dönüşümler: yedek.ts).
// 3) İki BAĞIMSIZ çıkış — biri başarısız olursa diğeri yine denenir:
//    a) "yedekler" private bucket'ına tarih damgalı isimle yükleme
//    b) Resend ile patolojiselcuktip@gmail.com'a e-posta eki
//    Hata console.error ile loglanır (Supabase → Edge Functions → Logs),
//    fonksiyon çökmez; sonuç JSON'da döner.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { base64, calismaKitabi, epostaMetni, ozetCikar, type YedekVerisi } from "./yedek.ts";

const ALICI = "patolojiselcuktip@gmail.com";
const GONDEREN = "İstem Yedek <onboarding@resend.dev>"; // Resend ücretsiz plan: doğrulanmış alan adı yok
const SAYFA = 1000;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// PostgREST tek istekte en fazla "max rows" (varsayılan 1000) satır döner —
// eskiden select("*") 1000'i aşan tabloyu SESSİZCE kesiyordu. Dönen satır
// sayısı kadar ilerleyip boş sayfa gelene kadar okunur (sunucudaki üst
// sınır ne olursa olsun doğru çalışır). Sıralama kararlı olsun diye
// benzersiz bir kolonla biter.
// deno-lint-ignore no-explicit-any
async function hepsiniOku(client: any, kaynak: string, select: string, siralama: string[]) {
  // deno-lint-ignore no-explicit-any
  const satirlar: any[] = [];
  for (;;) {
    let q = client.from(kaynak).select(select);
    for (const kolon of siralama) q = q.order(kolon, { ascending: true });
    const { data, error } = await q.range(satirlar.length, satirlar.length + SAYFA - 1);
    if (error) throw new Error(`${kaynak} okunamadı: ${error.message}`);
    if (!data || data.length === 0) return satirlar;
    satirlar.push(...data);
  }
}

const hataMetni = (e: unknown) => String((e as Error)?.message ?? e);

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const client = createClient(supabaseUrl, serviceRoleKey);

  // Türkiye yerel tarihi — cron 23:00 UTC'de (=02:00 TR, ertesi gün)
  // tetiklendiği için dosya adı TR takvimine göre doğru günü göstersin.
  const tarih = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" });
  const dosya = `istem_otomatik_yedek_${tarih}.xlsx`;

  // Veri okunamaz ya da dosya üretilemezse iki çıkış da imkânsız — tek ölümcül hata bu.
  let veri: YedekVerisi, bytes: ArrayBuffer;
  try {
    const [istemler, kalemler, log, kuyruk, kullanicilar, gruplar, notlar] = await Promise.all([
      hepsiniOku(client, "istemler", "*", ["created_at", "id"]),
      hepsiniOku(client, "istem_kalemleri", "*", ["created_at", "id"]),
      hepsiniOku(client, "istem_log", "*", ["created_at", "id"]),
      hepsiniOku(client, "istem_kuyruk_v", "*", ["created_at", "kalem_id"]),
      hepsiniOku(client, "kullanicilar", "id,ad_soyad", ["id"]), // pin vb. yedeğe girmez
      hepsiniOku(client, "test_gruplari", "kod,ad", ["kod"]),
      // Not tablosu okunamazsa (şema henüz kurulmadıysa) yedek İPTAL OLMAZ —
      // notlar eski tekil not_metni'nden yazılır, e-postada belirtilir.
      hepsiniOku(client, "istem_notlari", "*", ["created_at", "id"]).catch((e) => {
        console.error("[daily-backup] istem_notlari okunamadı:", e);
        return null;
      }),
    ]);
    veri = { istemler, kalemler, log, kuyruk, kullanicilar, gruplar, notlar };
    bytes = XLSX.write(calismaKitabi(XLSX, veri), { type: "array", bookType: "xlsx" });
  } catch (e) {
    console.error("[daily-backup] Yedek üretilemedi:", e);
    return Response.json({ ok: false, dosya, hata: hataMetni(e) }, { status: 500 });
  }
  const ozet = ozetCikar(veri);

  // a) Storage
  let depolama = "ok";
  try {
    const { error } = await client.storage.from("yedekler").upload(dosya, bytes, { contentType: XLSX_MIME, upsert: true });
    if (error) throw error;
  } catch (e) {
    depolama = hataMetni(e);
    console.error("[daily-backup] Storage'a yazılamadı:", e);
  }

  // b) E-posta — Storage'dan bağımsız; Storage başarısızsa e-postadaki ek
  // tek kopya olur (gövdede belirtilir). Resend anahtarı Vault'tan, cron'un
  // service_role anahtarını okuduğu sorguyla aynı yoldan (vault.decrypted_secrets)
  // — sadece service_role'ün çağırabildiği yedek_resend_anahtari() ile.
  let eposta = "ok";
  try {
    const { data: anahtar, error: e1 } = await client.rpc("yedek_resend_anahtari");
    if (e1) throw new Error(`Resend anahtarı Vault'tan okunamadı: ${e1.message}`);
    if (!anahtar) throw new Error("Vault'ta istem_resend_key bulunamadı");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${anahtar}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: GONDEREN,
        to: [ALICI],
        subject: `İstem Günlük Yedek — ${tarih}`,
        text: epostaMetni(ozet, dosya, depolama),
        attachments: [{ filename: dosya, content: base64(bytes) }],
      }),
    });
    const govde = await res.text();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${govde}`);
  } catch (e) {
    eposta = hataMetni(e);
    console.error("[daily-backup] E-posta gönderilemedi:", e);
  }

  // 200: ikisi de tamam · 207: biri başarısız · 500: ikisi de başarısız.
  const status = depolama === "ok" && eposta === "ok" ? 200 : depolama === "ok" || eposta === "ok" ? 207 : 500;
  return Response.json({ ok: status === 200, dosya, ozet, depolama, eposta }, { status });
});
