// rapor-istem çekirdeği — Deno'dan (index.ts) bağımsız, saf mantık; Node ile de test edilebilir.
//
// Rapor editörü (https://rapor-editoru.pages.dev) bir protokol (patoloji) no için istenen
// İHK / histokimya / genetik testlerin listesini okur. SALT OKUNUR.
// Dönen veride hasta adı, kimlik, istem notu, isteyen/uzman adı YOKTUR — yalnızca test listesi.
//
//   GET ?protokol=11240/26   → [{ ad, tur: 'ihk'|'histokimya'|'genetik', klon, durum }]
//   GET ?katalog=1           → [{ ad, tur, klon }]   (aktif test kataloğu; klon kaynağı)
//
// Yetki: "x-okuma-anahtari" başlığı, ortam değişkeni RAPOR_OKUMA_ANAHTARI ile karşılaştırılır.
// Anahtar tanımlı değilse uç kapalıdır (503). CORS yalnızca rapor editörünün kökenine açıktır.

export const IZINLI_KOKEN = "https://rapor-editoru.pages.dev";

// istem_kalemleri.grup / test_katalog.grup → rapor tarafındaki tür (diğer gruplar dönmez: kesit, hücre bloğu, yayma…)
export const TUR: Record<string, "ihk" | "histokimya" | "genetik"> = {
  ihc: "ihk", hk: "histokimya", mol: "genetik", fish: "genetik",
};

export type Kalem = { grup: string; test_adi: string | null; klon: string | null; durum: string };
export type KatalogSatiri = { grup: string; ad: string; klon: string | null };
export type Veri = {
  kalemler(patolojiNolari: string[]): Promise<Kalem[]>;
  katalog(): Promise<KatalogSatiri[]>;
};

// Editörde "14715/2026", istem sitesinde "14715/26" yazılabiliyor: iki biçimi de ara
export function noAdaylari(p: string): string[] {
  const t = p.trim().replace(/\s+/g, "");
  const out = new Set([t]);
  const m = t.match(/^(\d{1,7})[\/\-.](\d{2}|\d{4})$/);
  if (m) {
    const yy = m[2].length === 4 ? m[2].slice(2) : m[2];
    const yyyy = m[2].length === 4 ? m[2] : "20" + m[2];
    for (const n of [m[1], m[1].replace(/^0+/, "")]) if (n) { out.add(`${n}/${yy}`); out.add(`${n}/${yyyy}`); }
  }
  return [...out];
}

const DURUM_SIRA = ["bekleyen", "cihazda", "tamamlandi", "iptal"];
// Aynı test birden çok blokta istenmiş olabilir: rapora tek satır; durum en geride kalanınki (iptal yalnızca hepsi iptalse)
export function testListesi(rows: Kalem[]) {
  const map = new Map<string, { ad: string; tur: string; klon: string | null; durum: string }>();
  for (const r of rows) {
    const tur = TUR[r.grup]; const ad = (r.test_adi || "").trim();
    if (!tur || !ad) continue;
    const k = tur + "|" + ad.toLocaleLowerCase("tr") + "|" + (r.klon || "");
    const cur = map.get(k);
    if (!cur) { map.set(k, { ad, tur, klon: r.klon || null, durum: r.durum }); continue; }
    const a = DURUM_SIRA.indexOf(cur.durum), b = DURUM_SIRA.indexOf(r.durum);
    if (cur.durum === "iptal" || (b >= 0 && b < a && r.durum !== "iptal")) cur.durum = r.durum;
  }
  return [...map.values()];
}

export function katalogListesi(rows: KatalogSatiri[]) {
  return rows.filter(r => TUR[r.grup] && r.ad).map(r => ({ ad: r.ad.trim(), tur: TUR[r.grup], klon: r.klon || null }));
}

// sabit süreli karşılaştırma (anahtarın ne kadarının doğru olduğu süreden anlaşılmasın)
export function anahtarEsit(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

function yanit(body: unknown, status: number, origin: string | null) {
  const h: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" };
  if (origin === IZINLI_KOKEN) h["Access-Control-Allow-Origin"] = IZINLI_KOKEN;
  return new Response(JSON.stringify(body), { status, headers: h });
}

export async function isle(req: Request, env: { anahtar?: string }, veri: Veri): Promise<Response> {
  const origin = req.headers.get("Origin");
  // tarayıcıdan başka bir kökenden gelen istek: reddet (tarayıcı dışı istemcilerde Origin olmaz)
  if (origin && origin !== IZINLI_KOKEN) return new Response(null, { status: 403 });
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": IZINLI_KOKEN, "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-okuma-anahtari", "Access-Control-Max-Age": "600", "Vary": "Origin",
    } });
  }
  if (req.method !== "GET") return yanit({ hata: "yalnızca GET" }, 405, origin);
  const beklenen = env.anahtar || "";
  if (beklenen.length < 16) return yanit({ hata: "uç yapılandırılmamış (RAPOR_OKUMA_ANAHTARI)" }, 503, origin);
  if (!anahtarEsit(req.headers.get("x-okuma-anahtari") || "", beklenen)) return yanit({ hata: "yetkisiz" }, 401, origin);

  const url = new URL(req.url);
  try {
    if (url.searchParams.get("katalog") === "1") return yanit(katalogListesi(await veri.katalog()), 200, origin);
    const p = (url.searchParams.get("protokol") || "").trim();
    if (!/^[0-9A-Za-z\/\-. ]{1,40}$/.test(p)) return yanit({ hata: "geçersiz protokol no" }, 400, origin);
    return yanit(testListesi(await veri.kalemler(noAdaylari(p))), 200, origin);
  } catch (_e) {
    // ayrıntı (tablo/sorgu) dışarı verilmez
    return yanit({ hata: "okunamadı" }, 500, origin);
  }
}
