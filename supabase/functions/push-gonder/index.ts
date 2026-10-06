// push-gonder — Web Push bildirimleri (bkz. push_sema.sql).
// Supabase panel editörüne olduğu gibi yapıştırılabilsin diye TEK dosya;
// şifreleme (RFC 8291, aes128gcm) ve VAPID imzası (RFC 8292, ES256) dış
// paket olmadan, yerleşik WebCrypto ile.
//
// Gövdeye göre üç iş ("Verify JWT" AÇIK kalmalı — çağıranı ağ geçidi doğrular):
//  {"istem_id": "..."}    istem_kalemleri trigger'ı (service_role) → ilgili abonelere
//  {"islem": "anahtar"}   kurulum (service_role) → VAPID anahtarı yoksa üretip Vault'a
//                         yazar (istem_vapid_private / istem_vapid_public); özel anahtar
//                         HİÇBİR yere dönmez/loglanmaz
//  {"islem": "test"}      uygulamadaki kullanıcı (kendi oturumu) → yalnız kendi cihazlarına deneme
//
// Alıcılar: bildirim_tercihleri'nde istemin gruplarından birini seçmiş, aktif ve
// istemi AÇAN KİŞİ OLMAYAN kullanıcılar. Metin alıcının kendi gruplarına göre:
// "17730/26 · 3 İHK (Acil)". 404/410 dönen abonelik silinir.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ILETISIM = "mailto:patolojiselcuktip@gmail.com"; // VAPID "sub" — push servisi sorun olursa bunu görür
const TTL_SN = 6 * 3600;                                // 6 saatte ulaşamazsa bildirim bayatlar, düşer
const ESZAMANLI = 10;

// ================================================================
// base64url
// ================================================================
export function b64uEncode(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(s: string): Uint8Array {
  const t = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const b = atob(t + "===".slice((t.length + 3) % 4));
  const u8 = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
  return u8;
}
const birlestir = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) { out.set(x, o); o += x.length; }
  return out;
};
const metin = (s: string) => new TextEncoder().encode(s);

// ================================================================
// VAPID (RFC 8292) — ES256 imzalı JWT
// ================================================================
export async function vapidAnahtarUret(): Promise<{ acik: string; ozelJwk: string }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const acik = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { acik: b64uEncode(acik), ozelJwk: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y }) };
}

export interface Vapid { ozel: CryptoKey; acik: string }
export async function vapidYukle(ozelJwk: string, acik: string): Promise<Vapid> {
  const ozel = await crypto.subtle.importKey("jwk", JSON.parse(ozelJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { ozel, acik };
}

export async function vapidJwt(vapid: Vapid, aud: string, simdiSn = Math.floor(Date.now() / 1000)): Promise<string> {
  const bas = b64uEncode(metin(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const govde = b64uEncode(metin(JSON.stringify({ aud, exp: simdiSn + 12 * 3600, sub: ILETISIM })));
  // WebCrypto ECDSA imzası zaten JWS'in istediği ham r||s (64 bayt) biçiminde.
  const imza = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.ozel, metin(`${bas}.${govde}`)));
  return `${bas}.${govde}.${b64uEncode(imza)}`;
}

// ================================================================
// Şifreleme (RFC 8291, aes128gcm — tek kayıt)
// test için: tuz ve gönderen anahtar çifti dışarıdan verilebilir (RFC Ek A)
// ================================================================
async function hkdf(tuz: Uint8Array, ikm: Uint8Array, bilgi: Uint8Array, uzunluk: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: tuz, info: bilgi }, k, uzunluk * 8));
}

export async function sifrele(
  icerik: Uint8Array, p256dh: string, auth: string,
  test?: { tuz: Uint8Array; gonderenOzel: CryptoKey; gonderenAcik: Uint8Array },
): Promise<Uint8Array> {
  const uaAcik = b64uDecode(p256dh);
  const authSir = b64uDecode(auth);
  const uaKey = await crypto.subtle.importKey("raw", uaAcik, { name: "ECDH", namedCurve: "P-256" }, false, []);

  let asOzel: CryptoKey, asAcik: Uint8Array;
  if (test) { asOzel = test.gonderenOzel; asAcik = test.gonderenAcik; }
  else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asOzel = kp.privateKey;
    asAcik = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const tuz = test ? test.tuz : crypto.getRandomValues(new Uint8Array(16));

  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asOzel, 256));
  const ikm = await hkdf(authSir, ecdh, birlestir(metin("WebPush: info\0"), uaAcik, asAcik), 32);
  const cek = await hkdf(tuz, ikm, metin("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(tuz, ikm, metin("Content-Encoding: nonce\0"), 12);

  const anahtar = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sifreli = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, anahtar, birlestir(icerik, new Uint8Array([2]))));

  // başlık: tuz(16) | kayıt boyu rs=4096 (4 bayt) | idlen=65 | gönderen açık anahtarı(65)
  const baslik = birlestir(tuz, new Uint8Array([0, 0, 0x10, 0, 65]), asAcik);
  return birlestir(baslik, sifreli);
}

// ================================================================
// Tek aboneliğe gönderim
// ================================================================
export interface Abonelik { id?: string; endpoint: string; keys: { p256dh: string; auth: string } }
export async function pushGonder(ab: Abonelik, yuk: unknown, vapid: Vapid, acil = false): Promise<number> {
  const aud = new URL(ab.endpoint).origin;
  const body = await sifrele(metin(JSON.stringify(yuk)), ab.keys.p256dh, ab.keys.auth);
  const res = await fetch(ab.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${await vapidJwt(vapid, aud)}, k=${vapid.acik}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TTL_SN),
      Urgency: acil ? "high" : "normal",
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}

// ================================================================
// Bildirim metni — alıcının kendi gruplarına göre
// "17730/26 · 3 İHK (Acil)" · "17730/26 · 2 İHK · 1 HK (STAT)"
// ================================================================
export function bildirimMetni(patNo: string, oncelik: string, sayac: Map<string, number>, gruplar: Map<string, { kisa: string; sira: number }>): string {
  const parca = [...sayac].sort((a, b) => (gruplar.get(a[0])?.sira ?? 999) - (gruplar.get(b[0])?.sira ?? 999))
    .map(([g, n]) => `${n} ${gruplar.get(g)?.kisa || g}`);
  const onc = oncelik === "stat" ? " (STAT)" : oncelik === "acil" ? " (Acil)" : "";
  return `${patNo} · ${parca.join(" · ")}${onc}`;
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function anahtarlariOku(db: Db): Promise<Vapid | null> {
  const { data, error } = await db.rpc("push_anahtarlari");
  if (error) throw new Error(`VAPID anahtarı okunamadı: ${error.message}`);
  if (!data?.private || !data?.public) return null;
  return await vapidYukle(data.private, data.public);
}

// Abonelik listesine gönderir; 404/410 olanları siler. Bir alıcıdaki hata
// diğerlerini durdurmaz.
async function topluGonder(db: Db, vapid: Vapid, isler: { ab: Abonelik; yuk: unknown; acil: boolean }[]) {
  let gonderilen = 0, silinen = 0;
  const hatalar: string[] = [];
  for (let i = 0; i < isler.length; i += ESZAMANLI) {
    const dilim = isler.slice(i, i + ESZAMANLI);
    const sonuc = await Promise.allSettled(dilim.map((x) => pushGonder(x.ab, x.yuk, vapid, x.acil)));
    for (let j = 0; j < sonuc.length; j++) {
      const s = sonuc[j], ab = dilim[j].ab;
      if (s.status === "rejected") { hatalar.push(String((s.reason as Error)?.message ?? s.reason)); continue; }
      if (s.value === 404 || s.value === 410) {
        await db.from("push_abonelikleri").delete().eq("id", ab.id);
        silinen++;
      } else if (s.value >= 200 && s.value < 300) gonderilen++;
      else hatalar.push(`HTTP ${s.value} (${new URL(ab.endpoint).host})`);
    }
  }
  return { gonderilen, silinen, hatalar };
}

async function istemBildir(db: Db, istemId: string) {
  const { data: istem, error: e1 } = await db.from("istemler").select("id,patoloji_no,oncelik,istem_yapan_id").eq("id", istemId).maybeSingle();
  if (e1) throw new Error(`istem okunamadı: ${e1.message}`);
  if (!istem) return { gonderilen: 0, silinen: 0, hatalar: ["istem bulunamadı (silinmiş olabilir)"] };
  const { data: kalemler, error: e2 } = await db.from("istem_kalemleri").select("grup").eq("istem_id", istemId);
  if (e2) throw new Error(`kalemler okunamadı: ${e2.message}`);
  const sayac = new Map<string, number>();
  (kalemler ?? []).forEach((k: { grup: string }) => sayac.set(k.grup, (sayac.get(k.grup) ?? 0) + 1));
  if (!sayac.size) return { gonderilen: 0, silinen: 0, hatalar: [] };

  // Alıcı → seçtiği gruplar (istemi açan hariç)
  const { data: tercihler, error: e3 } = await db.from("bildirim_tercihleri").select("kullanici_id,grup_kod").in("grup_kod", [...sayac.keys()]);
  if (e3) throw new Error(`tercihler okunamadı: ${e3.message}`);
  const aliciGrup = new Map<string, Set<string>>();
  (tercihler ?? []).forEach((t: { kullanici_id: string; grup_kod: string }) => {
    if (t.kullanici_id === istem.istem_yapan_id) return;
    if (!aliciGrup.has(t.kullanici_id)) aliciGrup.set(t.kullanici_id, new Set());
    aliciGrup.get(t.kullanici_id)!.add(t.grup_kod);
  });
  if (!aliciGrup.size) return { gonderilen: 0, silinen: 0, hatalar: [] };

  const { data: aktifler } = await db.from("kullanicilar").select("id").in("id", [...aliciGrup.keys()]).eq("aktif", true);
  const aktif = new Set((aktifler ?? []).map((u: { id: string }) => u.id));
  const { data: abonelikler, error: e4 } = await db.from("push_abonelikleri").select("id,kullanici_id,endpoint,keys").in("kullanici_id", [...aktif]);
  if (e4) throw new Error(`abonelikler okunamadı: ${e4.message}`);
  if (!abonelikler?.length) return { gonderilen: 0, silinen: 0, hatalar: [] };

  const vapid = await anahtarlariOku(db);
  if (!vapid) throw new Error("VAPID anahtarı yok — kurulum adımı ({\"islem\":\"anahtar\"}) yapılmamış");
  const { data: tg } = await db.from("test_gruplari").select("kod,ad,kisa_ad,sira");
  const gruplar = new Map<string, { kisa: string; sira: number }>(
    (tg ?? []).map((g: { kod: string; ad: string; kisa_ad: string | null; sira: number }) => [g.kod, { kisa: g.kisa_ad || g.ad, sira: g.sira }]));

  const acil = istem.oncelik === "acil" || istem.oncelik === "stat";
  const isler = abonelikler.map((ab: Abonelik & { kullanici_id: string }) => {
    const benim = new Map([...sayac].filter(([g]) => aliciGrup.get(ab.kullanici_id)?.has(g)));
    return {
      ab, acil,
      yuk: { title: "Yeni istek", body: bildirimMetni(istem.patoloji_no, istem.oncelik, benim, gruplar), tag: `istem-${istem.id}`, url: "./", istem_id: istem.id },
    };
  });
  return await topluGonder(db, vapid, isler);
}

// JWT'nin "role" iddiası — imzayı ağ geçidi ("Verify JWT") zaten doğruladı.
function jwtRol(token: string): string | null {
  try { return JSON.parse(new TextDecoder().decode(b64uDecode(token.split(".")[1]))).role ?? null; } catch { return null; }
}

// "Deneme bildirimi" uygulamadan (tarayıcıdan, başka origin) çağrılır — tarayıcı
// önce OPTIONS ön-kontrolü yapar; izin başlıkları olmadan çağrıyı engeller.
// (Trigger çağrısı sunucudan gelir, CORS'tan etkilenmez.)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (veri: unknown, status = 200) => Response.json(veri, { status, headers: CORS });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const govde = await req.json().catch(() => ({}));
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const servisKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const servisMi = token === servisKey || jwtRol(token) === "service_role";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, servisKey);

  try {
    // ---- kurulum: anahtar üret (yalnız bir kez) ----
    if (govde.islem === "anahtar") {
      if (!servisMi) return json({ ok: false, hata: "yetkisiz" }, 403);
      if (await anahtarlariOku(db)) return json({ ok: true, anahtar: "mevcut" });
      const { acik, ozelJwk } = await vapidAnahtarUret();
      const { data: yazildi, error } = await db.rpc("vapid_anahtar_kaydet", { p_public: acik, p_private: ozelJwk });
      if (error) throw new Error(`Vault'a yazılamadı: ${error.message}`);
      return json({ ok: true, anahtar: yazildi ? "olusturuldu" : "mevcut" });
    }

    // ---- deneme: oturumdaki kullanıcının kendi cihazları ----
    if (govde.islem === "test") {
      const { data: u, error: eu } = await db.auth.getUser(token);
      if (eu || !u?.user) return json({ ok: false, hata: "oturum doğrulanamadı" }, 401);
      const { data: k } = await db.from("kullanicilar").select("id").eq("auth_user_id", u.user.id).maybeSingle();
      if (!k) return json({ ok: false, hata: "kullanıcı bulunamadı" }, 404);
      const { data: abonelikler } = await db.from("push_abonelikleri").select("id,endpoint,keys").eq("kullanici_id", k.id);
      if (!abonelikler?.length) return json({ ok: false, hata: "bu hesapta kayıtlı cihaz yok" }, 404);
      const vapid = await anahtarlariOku(db);
      if (!vapid) return json({ ok: false, hata: "VAPID anahtarı yok (kurulum yapılmamış)" }, 503);
      const r = await topluGonder(db, vapid, abonelikler.map((ab: Abonelik) => ({
        ab, acil: false, yuk: { title: "Deneme bildirimi", body: "Bildirimler bu cihazda çalışıyor.", tag: "istem-deneme", url: "./" },
      })));
      return json({ ok: r.gonderilen > 0, ...r });
    }

    // ---- trigger: yeni istem ----
    if (govde.istem_id) {
      if (!servisMi) return json({ ok: false, hata: "yetkisiz" }, 403);
      const r = await istemBildir(db, String(govde.istem_id));
      await db.from("push_gonderimleri").update({
        gonderildi_at: new Date().toISOString(), gonderilen: r.gonderilen, silinen: r.silinen, hata: r.hatalar.join("; ").slice(0, 500) || null,
      }).eq("istem_id", govde.istem_id);
      if (r.hatalar.length) console.error("[push-gonder] istem", govde.istem_id, r.hatalar);
      return json({ ok: true, ...r });
    }

    return json({ ok: false, hata: "Geçersiz istek: istem_id ya da islem (anahtar | test) gerekli" }, 400);
  } catch (e) {
    console.error("[push-gonder]", e);
    if (govde.istem_id) {
      await db.from("push_gonderimleri").update({ gonderildi_at: new Date().toISOString(), hata: String((e as Error)?.message ?? e).slice(0, 500) }).eq("istem_id", govde.istem_id);
    }
    return json({ ok: false, hata: String((e as Error)?.message ?? e) }, 500);
  }
});
