// rapor-istem — rapor editörüne bir patoloji no'nun İHK / histokimya / genetik test listesini verir (salt okunur).
// Ayrıntı ve güvenlik kuralları: cekirdek.ts. Kurulum: README.md → "Rapor editörü ucu".
//
// Dağıtım (JWT doğrulaması kapalı; yetki okuma anahtarıyla):
//   supabase secrets set RAPOR_OKUMA_ANAHTARI=<en az 16 karakter, rastgele>
//   supabase functions deploy rapor-istem --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isle, type Kalem, type KatalogSatiri } from "./cekirdek.ts";

// service_role: RLS yalnızca giriş yapmış kullanıcıya açık; bu uç yalnızca aşağıdaki kolonları okur
const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const veri = {
  async kalemler(nolar: string[]): Promise<Kalem[]> {
    const { data, error } = await client.from("istemler")
      .select("patoloji_no, istem_kalemleri(grup, durum, ozel_test, test_katalog(ad, klon))")
      .in("patoloji_no", nolar);
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    return (data ?? []).flatMap((i: any) => (i.istem_kalemleri ?? []).map((k: any) => ({
      grup: k.grup, durum: k.durum, test_adi: k.test_katalog?.ad ?? k.ozel_test ?? null, klon: k.test_katalog?.klon ?? null,
    })));
  },
  async katalog(): Promise<KatalogSatiri[]> {
    const { data, error } = await client.from("test_katalog").select("grup, ad, klon").eq("aktif", true).order("sira");
    if (error) throw error;
    return data ?? [];
  },
};

Deno.serve((req) => isle(req, { anahtar: Deno.env.get("RAPOR_OKUMA_ANAHTARI") }, veri));
