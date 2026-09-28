// Sahte veriyle test (gerçek hasta verisi kullanılmaz).
// Çalıştırma: node --test supabase/functions/rapor-istem/cekirdek.test.ts   (Node 22.6+ tür ayıklama)
import { test } from "node:test";
import assert from "node:assert/strict";
import { isle, noAdaylari, testListesi, IZINLI_KOKEN, type Kalem } from "./cekirdek.ts";

const ANAHTAR = "deneme-anahtari-0123456789";
const env = { anahtar: ANAHTAR };
let sorulanNolar: string[] = [];
// Sahte satırlar; gerçek tabloda olmayan "hasta_adi" gibi alanlar bile gelse çıktıya taşınmamalı
const SAHTE: Record<string, (Kalem & Record<string, unknown>)[]> = {
  "11240/26": [
    { grup: "ihc", test_adi: "ER", klon: "SP1", durum: "tamamlandi", hasta_adi: "SAHTE KİŞİ", tc: "00000000000" },
    { grup: "ihc", test_adi: "ER", klon: "SP1", durum: "bekleyen" },          // aynı test, başka blok
    { grup: "ihc", test_adi: "PR", klon: "BSB-2", durum: "iptal" },
    { grup: "hk", test_adi: "PAS", klon: null, durum: "cihazda" },
    { grup: "fish", test_adi: "HER2 FISH", klon: null, durum: "bekleyen" },
    { grup: "kesit", test_adi: "Derin kesit", klon: null, durum: "bekleyen" }, // rapora gitmez
    { grup: "diger", test_adi: "Serbest istek", klon: null, durum: "bekleyen" },
  ],
};
const veri = {
  async kalemler(nolar: string[]) { sorulanNolar = nolar; return nolar.flatMap(n => SAHTE[n] || []); },
  async katalog() { return [{ grup: "ihc", ad: "ER", klon: "SP1" }, { grup: "hk", ad: "PAS", klon: null }, { grup: "kesit", ad: "Seri kesit", klon: null }]; },
};
const istek = (q: string, h: Record<string, string> = {}, method = "GET") =>
  new Request("https://ornek.supabase.co/functions/v1/rapor-istem" + q, { method, headers: h });
const ok = { Origin: IZINLI_KOKEN, "x-okuma-anahtari": ANAHTAR };

test("ön kontrol (OPTIONS) yalnızca izinli kökene açık", async () => {
  const r = await isle(istek("", { Origin: IZINLI_KOKEN }, "OPTIONS"), env, veri);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), IZINLI_KOKEN);
  assert.match(r.headers.get("Access-Control-Allow-Headers") || "", /x-okuma-anahtari/);
  const r2 = await isle(istek("", { Origin: "https://kotu.example" }, "OPTIONS"), env, veri);
  assert.equal(r2.status, 403);
  assert.equal(r2.headers.get("Access-Control-Allow-Origin"), null);
});

test("başka kökenden gelen istek anahtar doğru olsa da reddedilir", async () => {
  const r = await isle(istek("?protokol=11240/26", { Origin: "https://kotu.example", "x-okuma-anahtari": ANAHTAR }), env, veri);
  assert.equal(r.status, 403);
});

test("anahtar tanımlı değilse uç kapalı (503)", async () => {
  const r = await isle(istek("?protokol=11240/26", ok), {}, veri);
  assert.equal(r.status, 503);
});

test("yanlış ya da eksik anahtar: 401", async () => {
  assert.equal((await isle(istek("?protokol=11240/26", { Origin: IZINLI_KOKEN, "x-okuma-anahtari": "yanlis" }), env, veri)).status, 401);
  assert.equal((await isle(istek("?protokol=11240/26", { Origin: IZINLI_KOKEN }), env, veri)).status, 401);
});

test("editör biçimi (14715/2026) istem biçimini (14715/26) de arar", () => {
  assert.deepEqual(noAdaylari("11240/2026").sort(), ["11240/2026", "11240/26"].sort());
  assert.ok(noAdaylari("11240/26").includes("11240/2026"));
  assert.ok(noAdaylari(" 0123/26 ").includes("123/26"));
  assert.deepEqual(noAdaylari("B-77"), ["B-77"]);
});

test("test listesi: yalnızca İHK/histokimya/genetik, tekilleştirilmiş, kimlik alanı yok", async () => {
  const r = await isle(istek("?protokol=" + encodeURIComponent("11240/2026"), ok), env, veri);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), IZINLI_KOKEN);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.ok(sorulanNolar.includes("11240/26"));
  const j = await r.json();
  assert.deepEqual(j, [
    { ad: "ER", tur: "ihk", klon: "SP1", durum: "bekleyen" },
    { ad: "PR", tur: "ihk", klon: "BSB-2", durum: "iptal" },
    { ad: "PAS", tur: "histokimya", klon: null, durum: "cihazda" },
    { ad: "HER2 FISH", tur: "genetik", klon: null, durum: "bekleyen" },
  ]);
  const metin = JSON.stringify(j);
  assert.ok(!/SAHTE|0000000|hasta|tc/.test(metin), "kimlik bilgisi dönmemeli");
  for (const x of j) assert.deepEqual(Object.keys(x).sort(), ["ad", "durum", "klon", "tur"]);
});

test("bilinmeyen protokol: boş liste", async () => {
  const r = await isle(istek("?protokol=1/26", ok), env, veri);
  assert.deepEqual(await r.json(), []);
});

test("geçersiz protokol no: 400", async () => {
  const r = await isle(istek("?protokol=" + encodeURIComponent("1'; drop table istemler;--"), ok), env, veri);
  assert.equal(r.status, 400);
});

test("katalog: yalnızca rapor türleri, klon ile", async () => {
  const r = await isle(istek("?katalog=1", ok), env, veri);
  assert.deepEqual(await r.json(), [{ ad: "ER", tur: "ihk", klon: "SP1" }, { ad: "PAS", tur: "histokimya", klon: null }]);
});

test("veritabanı hatası ayrıntısı dışarı sızmaz", async () => {
  const bozuk = { async kalemler(): Promise<Kalem[]> { throw new Error('relation "istemler" gizli ayrıntı'); }, async katalog() { return []; } };
  const r = await isle(istek("?protokol=11240/26", ok), env, bozuk);
  assert.equal(r.status, 500);
  assert.ok(!(await r.text()).includes("gizli"));
});

test("durum birleştirme: en geride kalan durum, iptal yalnızca hepsi iptalse", () => {
  const l = testListesi([
    { grup: "ihc", test_adi: "Ki-67", klon: "30-9", durum: "iptal" },
    { grup: "ihc", test_adi: "Ki-67", klon: "30-9", durum: "tamamlandi" },
  ]);
  assert.equal(l[0].durum, "tamamlandi");
});
