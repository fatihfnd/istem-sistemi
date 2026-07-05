// daily-backup — pg_cron tarafından her gece tetiklenir (bkz. yedekler_sema.sql).
// istemler + istem_kalemleri + istem_log tablolarını service_role ile
// (RLS'yi atlayarak) tam okur, 3 sayfalı bir .xlsx üretir ve
// "yedekler" private bucket'ına tarih damgalı isimle yükler.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

Deno.serve(async () => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const client = createClient(supabaseUrl, serviceRoleKey);

    const [istemler, istemKalemleri, istemLog] = await Promise.all([
      client.from("istemler").select("*"),
      client.from("istem_kalemleri").select("*"),
      client.from("istem_log").select("*"),
    ]);
    if (istemler.error) throw istemler.error;
    if (istemKalemleri.error) throw istemKalemleri.error;
    if (istemLog.error) throw istemLog.error;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(istemler.data ?? []), "istemler");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(istemKalemleri.data ?? []), "istem_kalemleri");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(istemLog.data ?? []), "istem_log");
    const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    // Türkiye yerel tarihi — cron 23:00 UTC'de (=02:00 TR, ertesi gün)
    // tetiklendiği için dosya adı TR takvimine göre doğru günü göstersin.
    const tarih = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" });
    const filename = `istem_otomatik_yedek_${tarih}.xlsx`;

    const { error: uploadError } = await client.storage
      .from("yedekler")
      .upload(filename, bytes, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: true,
      });
    if (uploadError) throw uploadError;

    return new Response(JSON.stringify({ ok: true, file: filename }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
