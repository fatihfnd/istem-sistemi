// yedek.ts — günlük yedeğin SAF dönüşümleri (ağ/IO yok): ham satırlardan
// okunabilir Excel sayfaları, özet, e-posta metni. index.ts kullanır; IO
// içermediği için yerelde sahte veriyle test edilebilir.
//
// ID → ad birleştirmesi: İş Kuyruğu'ndaki "Excel'e Aktar" ile AYNI kaynak —
// istem_kuyruk_v görünümü (isteyen_adi, uzman_adi, test_adi, cihaz_adi
// veritabanında join'leniyor). Tarayıcıdaki export kodu (app/app.js →
// KUYRUK_EXPORT_COLS) buraya import edilemiyor (farklı çalışma ortamı;
// Netlify sadece app/'i yayınlıyor), bu yüzden "İstem Kalemleri" sayfası
// o listenin sütunlarını/etiketlerini aynen izler. Etiketler değişirse
// iki yer birlikte güncellenmeli.

type Satir = Record<string, any>;

export const DURUM: Record<string, string> = { bekleyen: "Bekleyen", cihazda: "Cihazda", tamamlandi: "Tamamlandı", iptal: "İptal" };
export const ONCELIK: Record<string, string> = { rutin: "Rutin", acil: "Acil", stat: "STAT" };

// Edge Function UTC'de çalışır — tarihler Türkiye saatiyle yazılır
// (uygulamadaki formatDateFull ile aynı biçim).
export function tarihSaat(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("tr-TR", {
    timeZone: "Europe/Istanbul", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export interface YedekVerisi {
  istemler: Satir[];       // ham tablo
  kalemler: Satir[];       // ham istem_kalemleri
  log: Satir[];            // ham istem_log
  kuyruk: Satir[];         // istem_kuyruk_v (adlar join'li)
  kullanicilar: Satir[];   // id, ad_soyad
  gruplar: Satir[];        // test_gruplari: kod, ad
}

export interface Ozet {
  istem: number;
  kalem: number;
  log: number;
  durum: Record<string, number>;
}

const SUTUN_ISTEM = ["Patoloji No", "İsteyen", "Uzman Adına", "Öncelik", "Not", "Tarih", "Kalem Sayısı", "Tekrar", "Fatura Durumu", "Fatura Giren", "Fatura Zamanı"];
// İlk 13 sütun = KUYRUK_EXPORT_COLS (app.js) ile aynı sıra/etiket.
const SUTUN_KALEM = ["Patoloji No", "Blok", "Test", "Klon", "Tip", "İsteyen", "Uzman Adına", "Tarih", "Öncelik", "Durum", "Tekrar", "Not", "Kalite Notu", "Cihaz", "Tekrar Kaynağı", "Son Güncelleme"];
const SUTUN_LOG = ["Zaman", "Patoloji No", "Blok", "Test", "Eski Durum", "Yeni Durum", "Değiştiren"];

const yeniOnce = (a: Satir, b: Satir) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));

export function okunabilirSayfalar(v: YedekVerisi) {
  const kisi = new Map(v.kullanicilar.map((u) => [u.id, u.ad_soyad]));
  const tip = new Map(v.gruplar.map((g) => [g.kod, g.ad]));
  const kalem = new Map(v.kuyruk.map((k) => [k.kalem_id, k]));
  const ad = (id: string | null | undefined) => (id ? kisi.get(id) ?? "(silinmiş kullanıcı)" : "");
  const kalemTanim = (id: string) => {
    const k = kalem.get(id);
    return k ? `${k.patoloji_no} · ${k.blok_no || "—"} · ${k.test_adi} · ${tarihSaat(k.created_at)}` : "(silinmiş kalem)";
  };

  const istemSayac = new Map<string, { n: number; tekrar: number }>();
  v.kuyruk.forEach((k) => {
    const s = istemSayac.get(k.istem_id) ?? { n: 0, tekrar: 0 };
    s.n++;
    if (k.tekrar_kaynagi_id) s.tekrar++;
    istemSayac.set(k.istem_id, s);
  });

  const istemler = [...v.istemler].sort(yeniOnce).map((i) => {
    const s = istemSayac.get(i.id) ?? { n: 0, tekrar: 0 };
    return {
      "Patoloji No": i.patoloji_no,
      "İsteyen": ad(i.istem_yapan_id),
      "Uzman Adına": ad(i.uzman_id),
      "Öncelik": ONCELIK[i.oncelik] ?? i.oncelik ?? "",
      "Not": i.not_metni ?? "",
      "Tarih": tarihSaat(i.created_at),
      "Kalem Sayısı": s.n,
      "Tekrar": s.n > 0 && s.tekrar === s.n ? "Evet" : "",
      "Fatura Durumu": i.fatura_girildi ? "Girildi" : "Girilmedi",
      "Fatura Giren": ad(i.fatura_giren_id),
      "Fatura Zamanı": tarihSaat(i.fatura_zamani),
    };
  });

  const kalemler = [...v.kuyruk].sort(yeniOnce).map((r) => ({
    "Patoloji No": r.patoloji_no,
    "Blok": r.blok_no ?? "",
    "Test": r.test_adi ?? "",
    "Klon": r.klon ?? "",
    "Tip": tip.get(r.grup) ?? "Diğer",
    "İsteyen": r.isteyen_adi ?? "",
    "Uzman Adına": r.uzman_adi ?? "",
    "Tarih": tarihSaat(r.created_at),
    "Öncelik": ONCELIK[r.oncelik] ?? r.oncelik ?? "",
    "Durum": DURUM[r.durum] ?? r.durum ?? "",
    "Tekrar": r.tekrar_kaynagi_id ? "Evet" : "",
    "Not": r.not_metni ?? "",
    "Kalite Notu": r.kalite_notu ?? "",
    "Cihaz": r.cihaz_adi ?? "",
    "Tekrar Kaynağı": r.tekrar_kaynagi_id ? kalemTanim(r.tekrar_kaynagi_id) : "",
    "Son Güncelleme": tarihSaat(r.updated_at),
  }));

  const log = [...v.log].sort(yeniOnce).map((l) => {
    const k = kalem.get(l.istem_kalem_id);
    return {
      "Zaman": tarihSaat(l.created_at),
      "Patoloji No": k?.patoloji_no ?? "(silinmiş kalem)",
      "Blok": k?.blok_no ?? "",
      "Test": k?.test_adi ?? "",
      "Eski Durum": l.eski_durum ? DURUM[l.eski_durum] ?? l.eski_durum : "—",
      "Yeni Durum": DURUM[l.yeni_durum] ?? l.yeni_durum ?? "",
      "Değiştiren": ad(l.degistiren_id),
    };
  });

  return { istemler, kalemler, log };
}

export function ozetCikar(v: YedekVerisi): Ozet {
  const durum: Record<string, number> = {};
  v.kalemler.forEach((k) => { durum[k.durum] = (durum[k.durum] ?? 0) + 1; });
  return { istem: v.istemler.length, kalem: v.kalemler.length, log: v.log.length, durum };
}

// Sütun genişlikleri içeriğe göre (üst sınırlı) — dosya açılınca okunur olsun.
function sayfa(XLSX: any, rows: Satir[], header: string[]) {
  const ws = XLSX.utils.json_to_sheet(rows, { header });
  ws["!cols"] = header.map((h) => ({
    wch: Math.min(60, Math.max(h.length, ...rows.map((r) => String(r[h] ?? "").length)) + 2),
  }));
  return ws;
}

// Okunabilir sayfalar önde; "ham_*" sayfaları veritabanındaki satırların
// birebir kopyası (ID'ler dahil) — geri yükleme gerekirse ilişkiler bunlarla
// kurulur, o yüzden yedekten çıkarılmadı.
export function calismaKitabi(XLSX: any, v: YedekVerisi) {
  const s = okunabilirSayfalar(v);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sayfa(XLSX, s.istemler, SUTUN_ISTEM), "İstemler");
  XLSX.utils.book_append_sheet(wb, sayfa(XLSX, s.kalemler, SUTUN_KALEM), "İstem Kalemleri");
  XLSX.utils.book_append_sheet(wb, sayfa(XLSX, s.log, SUTUN_LOG), "Durum Geçmişi");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(v.istemler), "ham_istemler");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(v.kalemler), "ham_istem_kalemleri");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(v.log), "ham_istem_log");
  return wb;
}

export function epostaMetni(ozet: Ozet, dosya: string, depolama: string): string {
  const d = ozet.durum;
  return [
    `İstem günlük yedeği ekte: ${dosya}`,
    "",
    `Toplam istem: ${ozet.istem}`,
    `Toplam kalem: ${ozet.kalem} (Bekleyen ${d.bekleyen ?? 0} · Cihazda ${d.cihazda ?? 0} · Tamamlandı ${d.tamamlandi ?? 0})`,
    `Durum geçmişi kaydı: ${ozet.log}`,
    "",
    depolama === "ok"
      ? "Aynı dosya Storage'daki \"yedekler\" klasörüne de yazıldı."
      : `UYARI: Storage'a yazılamadı (${depolama}) — bu e-postadaki ek tek kopya.`,
  ].join("\n");
}

// Resend eki base64 ister. Büyük dizide String.fromCharCode(...hepsi) yığını
// taşırır — parça parça.
export function base64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
