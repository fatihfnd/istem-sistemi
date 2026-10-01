// ocr.js — Yeni İstek formundaki "tara" butonu: lam etiketindeki Patoloji
// No'yu kameradan okur (Tesseract.js, tarayıcıda — görüntü hiçbir sunucuya
// gönderilmez).
//
// Akış: kamera açılır (arka kamera, mümkünse sürekli otomatik odak; destekliyorsa
// fener butonu) → kullanıcı patoloji no satırını sabit çerçeveye hizalar →
// "Yakala" → SADECE çerçeve içi kırpılır ve sabit yüksekliğe ölçeklenir →
// gri ton + 3×3 medyan → NETLİK KONTROLÜ (kenar/gradyan keskinliği; bulanıksa
// OCR hiç çalışmaz, "biraz uzaklaşın" denir) → sırayla birkaç ön işleme
// stratejisi (aydınlatma düzeltme / uyarlanabilir eşikleme / gri ton) ile
// Tesseract (yalnız rakam ve "/", tek satır) → kalıba (/^\d+\/\d{2,3}$/) uyan
// İLK sonuç düzenlenebilir bir kutuda gösterilir, kullanıcı "Kullan" deyince
// forma yazılır. Hiçbiri uymazsa hiçbir şey doldurulmaz ("okunamadı" + "Elle
// Gir"). Form ASLA kendiliğinden gönderilmez; Blok No'ya dokunulmaz.
//
// Tesseract.js yalnızca ilk "tara"da CDN'den yüklenir (her sayfa açılışında
// değil). Dil verisi Tesseract'ın kendi IndexedDB önbelleğine yazılır,
// sonraki açılışlar hızlıdır.
(function () {
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  // Tüm metin kalıba uymalı (^…$) — kenardaki parazit karakterli sonuç kabul edilmez.
  const PAT_RE = /^\d+\/\d{2,3}$/;
  // Yükleme: betik + çekirdek (wasm) + dil verisi ilk seferde birkaç MB.
  const SURE_YUKLEME = 45000, SURE_TANIMA = 20000;
  const MESAJ_BAGLANTI = "Bağlantı yavaş ya da çevrimdışı — OCR bileşeni yüklenemedi. Patoloji No'yu elle girin.";
  // Kırpılan çerçeve bu yüksekliğe ölçeklenir (yazı ~50-60 px — Tesseract
  // için rahat boy). Sabit ölçek sayesinde netlik eşiği her telefonda aynı
  // anlama gelir; işlem de hızlı kalır.
  const HEDEF_H = 120;
  // Netlik (bkz. netlik()) bunun altındaysa görüntü bulanık sayılır ve OCR
  // çalıştırılmaz. Sentetik testte OCR 0.117'ye kadar okuyabildi, ağır
  // bulanıklık (ör. telefon etikete çok yakın) 0.08 ve altına iniyor — eşik
  // bilerek temkinli: okunabilir bir kareyi "bulanık" diye reddetmek, OCR'ı
  // boşuna denemekten daha kötü.
  const NETLIK_ESIGI = 0.10;

  // Sırayla denenir; kalıba uyan İLK sonuç kullanılır. Sıra sentetik testteki
  // başarıya göre (normal / loş / gölgeli / çok karanlık × 6 bulanıklık):
  //  - aydınlatma düzeltmeli gri: her piksel çevresinin ortalamasına bölünür
  //    (yansıma = ışık / aydınlatma) → gölge ve loş ışık silinir, ince "/"
  //    eşikte kaybolmaz; en geniş kapsama
  //  - uyarlanabilir eşik: blok ortalamasına göre siyah/beyaz; normal ışıkta
  //    ve ince yazıda sağlam
  //  - gerilmiş gri ton: Tesseract kendi ikilileştirmesini yapsın; diğer
  //    ikisinin kaçırdığı bazı loş + bulanık kareleri okuyor
  const STRATEJILER = [
    { ad: "aydınlatma düzeltmeli", uret: (ham) => ger(isikDuzelt(ham, 0.5)) },
    { ad: "uyarlanabilir eşik", uret: (ham) => uyarlanabilirEsik(ger(ham), Math.round(ham.h * 0.5), 0.10) },
    { ad: "gri ton", uret: (ham) => ger(ham) },
  ];

  function zamanAsimi(p, ms, mesaj) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(mesaj), { zamanAsimi: true })), ms); })])
      .finally(() => clearTimeout(t));
  }

  // ---------------- Tesseract (tembel yükleme, oturum boyunca tek worker) ----------------
  let scriptP = null, workerP = null;
  function tesseractYukle() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!scriptP) {
      scriptP = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL;
        s.async = true;
        s.onload = () => (window.Tesseract ? res(window.Tesseract) : rej(new Error(MESAJ_BAGLANTI)));
        s.onerror = () => rej(new Error(MESAJ_BAGLANTI));
        document.head.appendChild(s);
      });
      scriptP.catch(() => { scriptP = null; }); // bir sonraki denemede yeniden
    }
    return scriptP;
  }
  // Zaman aşımı sadece BEKLEMEYİ keser — yükleme arka planda sürer, bitince
  // worker bir sonraki deneme için hazır olur.
  function workerHazirla() {
    if (!workerP) {
      workerP = (async () => {
        const T = await tesseractYukle();
        const w = await T.createWorker("eng", 1); // 1 = LSTM
        await w.setParameters({
          tessedit_char_whitelist: "0123456789/",
          tessedit_pageseg_mode: T.PSM.SINGLE_LINE, // psm 7: tek satır
        });
        return w;
      })();
      workerP.catch(() => { workerP = null; });
    }
    return zamanAsimi(workerP, SURE_YUKLEME, MESAJ_BAGLANTI);
  }
  async function tani(canvas) {
    const w = await workerHazirla();
    try {
      const { data } = await zamanAsimi(w.recognize(canvas), SURE_TANIMA, "Okuma zaman aşımına uğradı — tekrar deneyin ya da elle girin.");
      return String(data.text || "").replace(/\s+/g, "");
    } catch (e) {
      if (e.zamanAsimi) { // takılmış worker'ı at, sonraki denemede yenisi kurulur
        workerP = null;
        w.terminate().catch(() => {});
      }
      throw e;
    }
  }

  // ---------------- Görüntü işleme (saf canvas, ek kütüphane yok) ----------------
  // Ekrandaki çerçevenin kapsadığı alanı videonun GERÇEK piksellerinde bulur
  // (video object-fit: cover ile ölçeklenip kırpılarak gösteriliyor), sadece
  // o bölgeyi alıp HEDEF_H yüksekliğe ölçekler.
  function cerceveyiKirp(video, frame) {
    const vr = video.getBoundingClientRect(), fr = frame.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const olcek = Math.max(vr.width / vw, vr.height / vh);
    const ox = (vr.width - vw * olcek) / 2, oy = (vr.height - vh * olcek) / 2;
    const sx = Math.max(0, (fr.left - vr.left - ox) / olcek);
    const sy = Math.max(0, (fr.top - vr.top - oy) / olcek);
    const sw = Math.min(vw - sx, fr.width / olcek);
    const sh = Math.min(vh - sy, fr.height / olcek);
    return olcekle(video, sx, sy, sw, sh);
  }
  function olcekle(kaynak, sx, sy, sw, sh) {
    const k = HEDEF_H / sh;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * k));
    c.height = HEDEF_H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(kaynak, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  function griTon(canvas) {
    const w = canvas.width, h = canvas.height, n = w * h;
    const src = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (src[j] * 299 + src[j + 1] * 587 + src[j + 2] * 114) / 1000;
    return { g, w, h };
  }

  // Yüzdelik (sıralı kopya üzerinden) — tam sayı ya da ondalık dizi.
  function yuzdelik(dizi, q) {
    const s = Float32Array.from(dizi).sort();
    return s[Math.floor(q * (s.length - 1))];
  }

  // Kontrast germe: en koyu %2 → 0, en açık %2 → 255. Loş ışıkta çekilen
  // (dar aralıklı) görüntüyü tam aralığa yayar. Girdi tam sayı ya da ondalık.
  function ger({ g, w, h }) {
    const lo = yuzdelik(g, 0.02), hi = yuzdelik(g, 0.98);
    const o = new Uint8Array(g.length);
    const k = hi - lo > 1e-6 ? 255 / (hi - lo) : 1;
    for (let i = 0; i < g.length; i++) o[i] = Math.max(0, Math.min(255, (g[i] - lo) * k));
    return { g: o, w, h };
  }

  // Integral görüntü: her dikdörtgenin toplamı O(1) — yerel ortalamalar için.
  function integral({ g, w, h }) {
    const W1 = w + 1, ig = new Float64Array(W1 * (h + 1));
    for (let y = 1; y <= h; y++) {
      let satir = 0;
      for (let x = 1; x <= w; x++) { satir += g[(y - 1) * w + (x - 1)]; ig[y * W1 + x] = ig[(y - 1) * W1 + x] + satir; }
    }
    return (x0, y0, x1, y1) => ig[(y1 + 1) * W1 + (x1 + 1)] - ig[y0 * W1 + (x1 + 1)] - ig[(y1 + 1) * W1 + x0] + ig[y0 * W1 + x0];
  }

  // Aydınlatma düzeltme: piksel / çevresinin ortalaması (oran × yükseklik
  // yarıçaplı pencere). Kâğıt/etiket her yerde ~1, yazı ~0.2-0.5 olur —
  // gölge, loş köşe, ışık gradyanı silinir; sert eşik uygulanmaz.
  function isikDuzelt({ g, w, h }, oran) {
    const r = Math.max(4, Math.round(h * oran)), top = integral({ g, w, h });
    const o = new Float32Array(g.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const ort = top(x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
        o[y * w + x] = g[y * w + x] / (ort + 1);
      }
    }
    return { g: o, w, h };
  }

  function medyan3({ g, w, h }) {
    const o = new Uint8Array(g.length), p = new Uint8Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
          for (let dx = -1; dx <= 1; dx++) p[m++] = g[yy + Math.min(w - 1, Math.max(0, x + dx))];
        }
        for (let a = 1; a < 9; a++) { const v = p[a]; let b = a - 1; while (b >= 0 && p[b] > v) { p[b + 1] = p[b]; b--; } p[b + 1] = v; }
        o[y * w + x] = p[4];
      }
    }
    return { g: o, w, h };
  }

  // Netlik — kenar/gradyan keskinliği (Tenengrad): 3×3 yumuşatılmış
  // görüntüde Sobel gradyan büyüklüğünün en üst %0.5'i, görüntünün kontrastına
  // (%98 − %2 parlaklık) bölünür. Net kenar dik → büyük oran; bulanık kenar
  // yayılır → oran düşer. Kontrasta bölündüğü için karanlık-ama-net kare
  // "bulanık" sanılmaz.
  // Neden Laplacian varyansı değil: sentetik testte loş/gürültülü karede
  // Laplacian varyansını gürültü belirliyor, bulanıklık arttıkça DÜŞMÜYOR
  // (bulanık loş kare "net" çıkıyor) — tam da düşük ışık senaryosunda işe
  // yaramıyor. Bu ölçü her ışık koşulunda bulanıklıkla düzenli azaldı.
  function netlik({ g, w, h }) {
    const top = integral({ g, w, h });
    const k = new Float32Array(g.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1), y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
        k[y * w + x] = top(x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
      }
    }
    const m = new Float32Array(Math.max(0, (w - 2) * (h - 2)));
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = k[i - w + 1] + 2 * k[i + 1] + k[i + w + 1] - k[i - w - 1] - 2 * k[i - 1] - k[i + w - 1];
        const gy = k[i + w - 1] + 2 * k[i + w] + k[i + w + 1] - k[i - w - 1] - 2 * k[i - w] - k[i - w + 1];
        m[n++] = Math.hypot(gx, gy) / 8;
      }
    }
    const kontrast = Math.max(1, yuzdelik(g, 0.98) - yuzdelik(g, 0.02));
    return n ? yuzdelik(m, 0.995) / kontrast : 0;
  }

  // UYARLANABİLİR EŞİKLEME: her piksel, çevresindeki blok×blok pencerenin
  // ORTALAMASIYLA kıyaslanır (integral görüntü → her pencere O(1)); ortalamanın
  // C oranı kadar altındaysa siyah. Tek global eşiğin aksine gölgeli/düzensiz
  // ışıkta her bölge kendi parlaklığına göre ikilileşir.
  function uyarlanabilirEsik({ g, w, h }, blok, C) {
    const r = Math.max(4, Math.round(blok / 2)), top = integral({ g, w, h });
    const o = new Uint8Array(g.length);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        const say = (x1 - x0 + 1) * (y1 - y0 + 1);
        o[y * w + x] = g[y * w + x] * say <= top(x0, y0, x1, y1) * (1 - C) ? 0 : 255;
      }
    }
    return { g: o, w, h };
  }

  // Tesseract koyu yazı / açık zemin bekler: çoğunluk koyuysa (açık yazı,
  // koyu zemin) ters çevrilir. Kenara beyaz pay eklenir.
  function tuvale({ g, w, h }) {
    let ort = 0;
    for (let i = 0; i < g.length; i++) ort += g[i];
    const ters = ort / g.length < 110;
    const PAY = 16;
    const out = document.createElement("canvas");
    out.width = w + PAY * 2;
    out.height = h + PAY * 2;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    const img = ctx.createImageData(w, h), d = img.data;
    for (let i = 0, j = 0; i < g.length; i++, j += 4) { const v = ters ? 255 - g[i] : g[i]; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    ctx.putImageData(img, PAY, PAY);
    return out;
  }

  // Kırpılmış kare → { netlik, adaylar: [{ad, canvas}] } (henüz OCR yok).
  // Adaylar tembel üretilir: ilk strateji tutarsa diğerleri hiç hesaplanmaz.
  function hazirla(kirpik) {
    const ham = medyan3(griTon(kirpik)); // aydınlatma düzeltme ham (gerilmemiş) parlaklık ister
    return {
      netlik: netlik(ham),
      adaylar: STRATEJILER.map((s) => {
        let c = null;
        return { ad: s.ad, get canvas() { return c || (c = tuvale(s.uret(ham))); } };
      }),
    };
  }

  // ---------------- Arayüz ----------------
  let ov = null, akis = null, fenerAcik = false;

  function kapat() {
    if (akis) { akis.getTracks().forEach((t) => t.stop()); akis = null; } // fener de kapanır
    fenerAcik = false;
    if (ov) { ov.remove(); ov = null; }
    document.removeEventListener("keydown", escKapat);
  }
  function escKapat(e) { if (e.key === "Escape") kapat(); }

  function durum(metin, hata) {
    const el = ov && ov.querySelector(".ocr-durum");
    if (!el) return;
    el.textContent = metin || "";
    el.classList.toggle("hata", Boolean(hata));
  }
  // "kamera" | "isleniyor" | "sonuc" | "okunamadi" | "hata"
  function asama(a) {
    if (!ov) return;
    const goster = {
      yakala: a === "kamera" || a === "isleniyor",
      tekrar: a === "sonuc" || a === "okunamadi",
      elle: a === "okunamadi" || a === "hata",
      kullan: a === "sonuc",
    };
    Object.entries(goster).forEach(([k, v]) => { ov.querySelector(`[data-ocr="${k}"]`).hidden = !v; });
    ov.querySelector('[data-ocr="yakala"]').disabled = a !== "kamera";
    ov.querySelector('[data-ocr="iptal"]').textContent = a === "okunamadi" || a === "hata" ? "Kapat" : "İptal";
    ov.querySelector(".ocr-sonuc").hidden = a !== "sonuc";
    ov.querySelector(".ocr-onizleme").hidden = !(a === "isleniyor" || a === "sonuc" || a === "okunamadi");
    ov.classList.toggle("donuk", a !== "kamera");
  }
  function onizle(canvas) {
    const on = ov.querySelector(".ocr-onizleme");
    on.width = canvas.width;
    on.height = canvas.height;
    on.getContext("2d").drawImage(canvas, 0, 0);
  }

  async function yakala(onSonuc) {
    const video = ov.querySelector("video"), frame = ov.querySelector(".ocr-frame");
    if (!video.videoWidth) return;
    asama("isleniyor");
    durum("Okunuyor…");
    video.pause(); // kullanıcı neyin okunduğunu görsün
    try {
      const { netlik: n, adaylar } = hazirla(cerceveyiKirp(video, frame));
      onizle(adaylar[0].canvas);
      if (n < NETLIK_ESIGI) {
        // OCR'ı hiç çalıştırma — bulanık karede zaman kaybı ve kötü sonuç.
        asama("okunamadi");
        durum("Görüntü bulanık — telefonu biraz uzaklaştırıp (15–20 cm) sabit tutun ve tekrar deneyin.", true);
        return;
      }
      let son = "";
      for (let i = 0; i < adaylar.length; i++) {
        if (!ov) return; // bu arada kapatıldı
        onizle(adaylar[i].canvas);
        durum(!window.Tesseract || !workerP ? "OCR bileşeni hazırlanıyor (ilk seferde birkaç saniye)…" : `Okunuyor… (deneme ${i + 1}/${adaylar.length})`);
        const metin = await tani(adaylar[i].canvas);
        if (!ov) return;
        if (PAT_RE.test(metin)) {
          asama("sonuc");
          durum("");
          const inp = ov.querySelector(".ocr-sonuc input");
          inp.value = metin;
          inp.focus();
          inp.select();
          return;
        }
        if (metin) son = metin;
      }
      asama("okunamadi");
      durum(`Okunamadı${son ? ` ("${son}" — kalıba uymuyor)` : ""}. Tekrar deneyin ya da "Elle Gir" ile yazın.`, true);
    } catch (e) {
      if (!ov) return;
      asama("okunamadi");
      durum(e && e.message ? e.message : "Okunamadı — elle girin.", true);
    } finally {
      if (ov) {
        ov.querySelector('[data-ocr="kullan"]').onclick = () => {
          const v = ov.querySelector(".ocr-sonuc input").value.trim();
          if (!v) { durum("Boş bırakılamaz — düzeltin ya da İptal'e basın.", true); return; }
          kapat();
          onSonuc(v);
        };
      }
    }
  }

  // Fener (torch) — sadece cihaz/tarayıcı destekliyorsa buton görünür
  // (Android Chrome'da çoğunlukla var; iOS Safari'de genelde yok).
  // Sürekli otomatik odak da destekleniyorsa istenir.
  function kameraOzellikleri() {
    const track = akis && akis.getVideoTracks()[0];
    if (!track || !ov) return;
    const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous")) {
      track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
    }
    const btn = ov.querySelector(".ocr-fener");
    btn.hidden = !caps.torch;
    btn.onclick = async () => {
      try {
        await track.applyConstraints({ advanced: [{ torch: !fenerAcik }] });
        fenerAcik = !fenerAcik;
        btn.classList.toggle("on", fenerAcik);
        btn.setAttribute("aria-pressed", String(fenerAcik));
      } catch (e) {
        btn.hidden = true;
        durum("Fener bu cihazda açılamadı.", true);
      }
    };
  }

  async function ac({ onSonuc, onElle }) {
    kapat();
    ov = document.createElement("div");
    ov.className = "ocr-ov";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Patoloji No tara");
    ov.innerHTML = `
      <div class="ocr-stage">
        <video playsinline muted autoplay></video>
        <div class="ocr-frame" aria-hidden="true"></div>
        <button type="button" class="ocr-fener" hidden aria-pressed="false" aria-label="Feneri aç/kapat" title="Fener">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h12v4l-2 4v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10L6 6z"/><path d="M6 6h12M12 13v3"/></svg>
          <span>Fener</span>
        </button>
      </div>
      <div class="ocr-panel">
        <div class="ocr-ipucu">Telefonu etiketten <b>yaklaşık 15–20 cm</b> uzakta tutun, çok yaklaştırmayın. Patoloji no satırını çerçevenin içine hizalayıp "Yakala"ya basın.</div>
        <canvas class="ocr-onizleme" hidden></canvas>
        <div class="ocr-sonuc" hidden>
          <label for="ocrDeger">Okunan Patoloji No — kontrol edin, gerekirse düzeltin</label>
          <input id="ocrDeger" class="finput" autocomplete="off" inputmode="numeric">
        </div>
        <div class="ocr-durum" role="status" aria-live="polite"></div>
        <div class="ocr-btns">
          <button type="button" class="btn-ghost" data-ocr="iptal">İptal</button>
          <button type="button" class="btn-ghost" data-ocr="tekrar" hidden>Tekrar Dene</button>
          <button type="button" class="btn-ghost" data-ocr="elle" hidden>Elle Gir</button>
          <button type="button" class="btn-primary" data-ocr="yakala" disabled>Yakala</button>
          <button type="button" class="btn-primary" data-ocr="kullan" hidden>Kullan</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.addEventListener("keydown", escKapat);
    ov.querySelector('[data-ocr="iptal"]').onclick = kapat;
    ov.querySelector('[data-ocr="elle"]').onclick = () => { kapat(); if (onElle) onElle(); };
    ov.querySelector('[data-ocr="yakala"]').onclick = () => yakala(onSonuc);
    ov.querySelector('[data-ocr="tekrar"]').onclick = () => {
      asama("kamera");
      durum("");
      ov.querySelector("video").play().catch(() => {});
    };
    ov.querySelector(".ocr-sonuc input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); ov.querySelector('[data-ocr="kullan"]').click(); }
    });
    asama("kamera");

    if (!navigator.onLine && !window.Tesseract) durum("Çevrimdışısınız — OCR bileşeni yüklenemeyebilir; okunamazsa elle girin.", true);
    workerHazirla().catch(() => {}); // kamera açılırken arka planda hazırla

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      asama("hata");
      durum("Kamera bu bağlantıda kullanılamıyor (güvenli bağlantı/HTTPS gerekli). Patoloji No'yu elle girin.", true);
      return;
    }
    try {
      akis = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: "continuous" }], // desteklemeyen cihazda yok sayılır
        },
        audio: false,
      });
      if (!ov) { akis.getTracks().forEach((t) => t.stop()); akis = null; return; }
      const video = ov.querySelector("video");
      video.srcObject = akis;
      await video.play().catch(() => {});
      const hazir = () => {
        if (!ov || !video.videoWidth) return;
        ov.querySelector('[data-ocr="yakala"]').disabled = false;
        kameraOzellikleri(); // bazı Android'lerde yetenekler ancak görüntü gelince okunabiliyor
      };
      video.addEventListener("loadedmetadata", hazir);
      hazir();
    } catch (e) {
      if (!ov) return;
      asama("hata");
      const ad = e && e.name;
      durum(ad === "NotAllowedError" ? "Kamera izni verilmedi — tarayıcı ayarlarından izin verin ya da Patoloji No'yu elle girin."
        : ad === "NotFoundError" || ad === "OverconstrainedError" ? "Kamera bulunamadı — Patoloji No'yu elle girin."
        : ad === "NotReadableError" ? "Kamera başka bir uygulama tarafından kullanılıyor — kapatıp tekrar deneyin."
        : "Kamera açılamadı — Patoloji No'yu elle girin.", true);
    }
  }

  // _ic: test/hata ayıklama içindir (uygulama kullanmaz).
  window.PatolojiOCR = { ac, kapat, PAT_RE, _ic: { hazirla, olcekle, netlik, tani, NETLIK_ESIGI, STRATEJILER } };
})();
