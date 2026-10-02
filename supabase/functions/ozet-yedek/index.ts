// ozet-yedek — haftalık / aylık ÖZET istatistik dosyası (günlük ham veri
// yedeğinden — daily-backup — ayrı ve ek). pg_cron tetikler (bkz.
// ozet_yedek_sema.sql):
//   haftalik-istem-ozet  0 2 * * 1  (Pazartesi 05:00 TR) → {"periyot":"hafta"}
//   aylik-istem-ozet     0 2 1 * *  (ayın 1'i 05:00 TR)  → {"periyot":"ay"}
//
// Gövde: {"periyot":"hafta"|"ay", "bas"?: "YYYY-AA-GG"}
//  - bas yoksa: çalıştığı güne göre (Türkiye takvimi) ÖNCEKİ hafta (Pzt–Paz)
//    ya da önceki ay
//  - bas varsa: o tarihi içeren hafta / ay (elle deneme, geçmişe dönük üretim)
//
// Hesap İstatistikler sayfasıyla AYNI: public.istatistik() RPC'si
// (service_role ile çağrılır; mantık veritabanında tek yerde).
// Çıkışlar daily-backup ile aynı ve BAĞIMSIZ: "yedekler" bucket'ı +
// Resend e-postası (anahtar Vault'tan, yedek_resend_anahtari()).
// Supabase panel editörüne olduğu gibi yapıştırılabilsin diye tek dosya.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

const ALICI = "patolojiselcuktip@gmail.com";
const GONDEREN = "İstem Yedek <onboarding@resend.dev>"; // Resend ücretsiz plan: doğrulanmış alan adı yok
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TZ = "Europe/Istanbul";

type Satir = Record<string, any>;

// ---------------- Dönem hesabı (saf) ----------------
// Takvim günleri UTC gece yarısı Date olarak taşınır — yalnız gün aritmetiği.
const GUN_MS = 86400000;
const gunDate = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const ekle = (d: Date, n: number) => new Date(d.getTime() + n * GUN_MS);
const iki = (n: number) => String(n).padStart(2, "0");

export function trBugun(simdi: Date): string {
  return simdi.toLocaleDateString("sv-SE", { timeZone: TZ });
}

// ISO 8601 hafta: haftanın Perşembe'si hangi yıldaysa hafta o yılındır.
export function isoHafta(pazartesi: Date): { yil: number; hafta: number } {
  const persembe = ekle(pazartesi, 3);
  const yil = persembe.getUTCFullYear();
  const yilinGunu = Math.round((persembe.getTime() - Date.UTC(yil, 0, 1)) / GUN_MS);
  return { yil, hafta: Math.floor(yilinGunu / 7) + 1 };
}

const kisaTarih = (d: Date, yilli = false) =>
  d.toLocaleDateString("tr-TR", { timeZone: "UTC", day: "numeric", month: "short", ...(yilli ? { year: "numeric" } : {}) });

export interface Donem {
  periyot: "hafta" | "ay";
  bas: string;        // YYYY-AA-GG (dahil)
  bit: string;        // YYYY-AA-GG (dahil)
  kod: string;        // 2026-W40 | 2026-09
  etiket: string;     // "28 Eyl – 4 Eki 2026" | "Eylül 2026"
  dosya: string;
  dokum: "day" | "week"; // istatistik() döküm periyodu
}

export function donemHesapla(periyot: string, simdi: Date, bas?: string): Donem {
  if (periyot === "hafta") {
    const ref = bas ? gunDate(bas) : ekle(gunDate(trBugun(simdi)), -7);
    const pzt = ekle(ref, -((ref.getUTCDay() + 6) % 7));
    const paz = ekle(pzt, 6);
    const { yil, hafta } = isoHafta(pzt);
    const kod = `${yil}-W${iki(hafta)}`;
    return {
      periyot, bas: ymd(pzt), bit: ymd(paz), kod,
      etiket: `${kisaTarih(pzt, pzt.getUTCFullYear() !== paz.getUTCFullYear())} – ${kisaTarih(paz, true)}`,
      dosya: `istem_haftalik_ozet_${kod}.xlsx`, dokum: "day",
    };
  }
  if (periyot === "ay") {
    const bugun = gunDate(trBugun(simdi));
    const ref = bas ? gunDate(bas) : ekle(new Date(Date.UTC(bugun.getUTCFullYear(), bugun.getUTCMonth(), 1)), -1);
    const ilk = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    const son = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
    const kod = `${ilk.getUTCFullYear()}-${iki(ilk.getUTCMonth() + 1)}`;
    const ad = ilk.toLocaleDateString("tr-TR", { timeZone: "UTC", month: "long", year: "numeric" });
    return { periyot, bas: ymd(ilk), bit: ymd(son), kod, etiket: ad, dosya: `istem_aylik_ozet_${kod}.xlsx`, dokum: "week" };
  }
  throw new Error(`Geçersiz periyot: ${periyot} (hafta | ay olmalı)`);
}

// ---------------- Biçimleme (saf) ----------------
export function fmtSure(saat: number | null | undefined): string {
  if (saat === null || saat === undefined) return "—";
  const h = Number(saat);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} dk`;
  if (h < 48) return `${h.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} sa`;
  return `${(h / 24).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} gün`;
}
const tarihTR = (s: string) => gunDate(s).toLocaleDateString("tr-TR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
const tarihSaat = (d: Date) => d.toLocaleString("tr-TR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const sayi = (x: unknown) => (x === null || x === undefined ? "" : Number(x));

// Döküm satırının etiketi: gün → "Pzt 28.09.2026"; hafta → aralığa kırpılmış "28.09 – 04.10".
function dokumEtiketi(d: string, dokum: string, bas: string, bit: string): string {
  const t = gunDate(String(d).slice(0, 10));
  if (dokum === "day") return `${t.toLocaleDateString("tr-TR", { timeZone: "UTC", weekday: "short" })} ${tarihTR(ymd(t))}`;
  const a = t < gunDate(bas) ? gunDate(bas) : t;
  const z0 = ekle(t, 6), z = z0 > gunDate(bit) ? gunDate(bit) : z0;
  // Yılsız tr-TR biçimi ICU'da "01/09" çıkıyor — elle "01.09".
  const f = (x: Date) => `${iki(x.getUTCDate())}.${iki(x.getUTCMonth() + 1)}`;
  return `${f(a)} – ${f(z)}`;
}

function sayfa(rows: (string | number)[][], genislik?: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = (genislik ?? rows[0].map((_, i) => Math.min(48, Math.max(...rows.map((r) => String(r[i] ?? "").length)) + 2)))
    .map((wch) => ({ wch }));
  return ws;
}

export function calismaKitabi(s: Satir, dn: Donem, olusturma: Date) {
  const o = s.ozet ?? {};
  const tipler: Satir[] = s.tipler ?? [];
  const toplamKalem = Number(o.kalem ?? 0);
  const baslik = dn.periyot === "hafta" ? "Haftalık özet" : "Aylık özet";
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, sayfa([
    ["Rapor", baslik],
    ["Dönem", `${dn.kod} (${dn.etiket})`],
    ["Aralık", `${tarihTR(dn.bas)} – ${tarihTR(dn.bit)} (Türkiye saati, iki gün de dahil)`],
    ["Toplam istem", sayi(o.istem)],
    ["Toplam kalem", sayi(o.kalem)],
    ["Tekrar kalem", sayi(o.tekrar)],
    ["Tamamlanan kalem", sayi(o.tamamlanan)],
    ["Ort. tamamlanma (saat)", sayi(o.ort_saat)],
    ["Medyan tamamlanma (saat)", sayi(o.medyan_saat)],
    ["Açık kalem (rapor anında)", sayi(o.acik)],
    ["Oluşturulma", tarihSaat(olusturma)],
    [],
    ["Not", "İstem/kalem/tip/kullanıcı/uzman sayıları istendiği döneme sayılır. Tamamlanma süresi: kalemin istenmesinden son \"Tamamlandı\"ya geçişine kadar; tamamlanma tarihi aralıktaki kalemler sayılır. Silinmiş kalemler sayılmaz. Hesap İstatistikler sayfasıyla aynıdır."],
  ], [28, 60]), "Özet");

  const dokumBaslik = [dn.dokum === "day" ? "Gün" : "Hafta", "İstem", "Kalem", ...tipler.map((t) => t.ad ?? t.kod), "Tekrar", "Tamamlanan", "Ort. süre (saat)", "Medyan (saat)"];
  XLSX.utils.book_append_sheet(wb, sayfa([
    dokumBaslik,
    ...(s.donemler ?? []).map((d: Satir) => [
      dokumEtiketi(d.d, dn.dokum, dn.bas, dn.bit), sayi(d.istem), sayi(d.kalem),
      ...tipler.map((t) => Number(d.tipler?.[t.kod] ?? 0)),
      sayi(d.tekrar), sayi(d.tamamlanan), sayi(d.ort_saat), sayi(d.medyan_saat),
    ]),
  ]), dn.dokum === "day" ? "Günlük Döküm" : "Haftalık Döküm");

  XLSX.utils.book_append_sheet(wb, sayfa([
    ["Tip", "Kalem", "Yüzde"],
    ...tipler.map((t) => [t.ad ?? t.kod, Number(t.n), toplamKalem ? Math.round((Number(t.n) / toplamKalem) * 1000) / 10 : 0]),
  ]), "Tip Dağılımı");

  const kisiler = (list: Satir[] | undefined, baslik: string) => sayfa([
    [baslik, "Kısaltma", "İstem"],
    ...(list ?? []).map((u) => [u.ad ?? "", u.kisaltma ?? "", Number(u.istem)]),
  ]);
  XLSX.utils.book_append_sheet(wb, kisiler(s.kullanicilar, "Kullanıcı (isteyen)"), "Kullanıcı Bazında");
  XLSX.utils.book_append_sheet(wb, kisiler(s.uzmanlar, "Uzman (adına istenen)"), "Uzman Adına");
  return wb;
}

export function epostaKonusu(dn: Donem): string {
  return dn.periyot === "hafta" ? `İstem Haftalık Özet — ${dn.kod} (${dn.etiket})` : `İstem Aylık Özet — ${dn.etiket}`;
}

export function epostaMetni(s: Satir, dn: Donem, depolama: string): string {
  const o = s.ozet ?? {};
  const n = (x: unknown) => Number(x ?? 0).toLocaleString("tr-TR");
  const enCok = (s.tipler ?? []).slice(0, 4).map((t: Satir) => `${t.ad ?? t.kod} ${n(t.n)}`).join(", ");
  return [
    `İstem ${dn.periyot === "hafta" ? "haftalık" : "aylık"} özeti ekte: ${dn.dosya}`,
    `Dönem: ${dn.kod} (${dn.etiket})`,
    "",
    `Toplam istem: ${n(o.istem)}`,
    `Toplam kalem: ${n(o.kalem)}${o.tekrar ? ` (${n(o.tekrar)} tekrar)` : ""}`,
    `Tamamlanan kalem: ${n(o.tamamlanan)} — ort. ${fmtSure(o.ort_saat)}, medyan ${fmtSure(o.medyan_saat)}`,
    enCok ? `En çok istenen tipler: ${enCok}` : "Bu dönemde kalem yok.",
    `Açık kalem (rapor anında): ${n(o.acik)}`,
    "",
    depolama === "ok"
      ? "Aynı dosya Storage'daki \"yedekler\" klasörüne de yazıldı (uygulamada Yönetim → Yedekler)."
      : `UYARI: Storage'a yazılamadı (${depolama}) — bu e-postadaki ek tek kopya.`,
  ].join("\n");
}

// Resend eki base64 ister; büyük dizide yığın taşmasın diye parça parça.
function base64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const hataMetni = (e: unknown) => String((e as Error)?.message ?? e);

Deno.serve(async (req: Request) => {
  const govde = await req.json().catch(() => ({}));
  const simdi = new Date();
  let dn: Donem;
  try {
    if (govde.bas !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(govde.bas))) throw new Error(`Geçersiz bas: ${govde.bas} (YYYY-AA-GG olmalı)`);
    dn = donemHesapla(String(govde.periyot ?? ""), simdi, govde.bas);
  } catch (e) {
    return Response.json({ ok: false, hata: hataMetni(e) }, { status: 400 });
  }

  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // İstatistik alınamaz ya da dosya üretilemezse iki çıkış da imkânsız — tek ölümcül hata bu.
  let stat: Satir, bytes: ArrayBuffer;
  try {
    const { data, error } = await client.rpc("istatistik", { p_bas: dn.bas, p_bit: dn.bit, p_periyot: dn.dokum });
    if (error) throw new Error(`istatistik() çağrılamadı: ${error.message}`);
    stat = data;
    bytes = XLSX.write(calismaKitabi(stat, dn, simdi), { type: "array", bookType: "xlsx" });
  } catch (e) {
    console.error("[ozet-yedek] Özet üretilemedi:", e);
    return Response.json({ ok: false, dosya: dn.dosya, hata: hataMetni(e) }, { status: 500 });
  }

  // a) Storage
  let depolama = "ok";
  try {
    const { error } = await client.storage.from("yedekler").upload(dn.dosya, bytes, { contentType: XLSX_MIME, upsert: true });
    if (error) throw error;
  } catch (e) {
    depolama = hataMetni(e);
    console.error("[ozet-yedek] Storage'a yazılamadı:", e);
  }

  // b) E-posta — Storage'dan bağımsız (daily-backup ile aynı yol).
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
        subject: epostaKonusu(dn),
        text: epostaMetni(stat, dn, depolama),
        attachments: [{ filename: dn.dosya, content: base64(bytes) }],
      }),
    });
    const cevap = await res.text();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${cevap}`);
  } catch (e) {
    eposta = hataMetni(e);
    console.error("[ozet-yedek] E-posta gönderilemedi:", e);
  }

  // 200: ikisi de tamam · 207: biri başarısız · 500: ikisi de başarısız.
  const status = depolama === "ok" && eposta === "ok" ? 200 : depolama === "ok" || eposta === "ok" ? 207 : 500;
  return Response.json({ ok: status === 200, dosya: dn.dosya, donem: { bas: dn.bas, bit: dn.bit, kod: dn.kod }, ozet: stat.ozet, depolama, eposta }, { status });
});
