// Module 4 — Creative library (Vercel Blob uploads, hash dedup). docs/PRODUCT_SPEC.md §4.
import { PageHeader, Card } from "@/components/ui";
import { CreativeUploader } from "@/components/creative-uploader";
import { listCreatives } from "@/lib/creatives";

export const dynamic = "force-dynamic";

export default async function CreativesPage() {
  let items: Awaited<ReturnType<typeof listCreatives>> = [];
  let dbError: string | null = null;
  try {
    items = await listCreatives();
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <PageHeader title="Creatives" subtitle="Upload images & video; deduped by content hash" />

      <Card className="mb-4">
        <CreativeUploader />
        {dbError && (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            Storage/DB not connected ({dbError}). Set DATABASE_URL + BLOB_READ_WRITE_TOKEN.
          </p>
        )}
      </Card>

      {items.length === 0 ? (
        <Card className="text-sm text-black/60 dark:text-white/60">No creatives yet.</Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {items.map((c) => (
            <Card key={c.id} className="space-y-2">
              {c.type === "video" ? (
                <video src={c.blobUrl} className="aspect-square w-full rounded object-cover" muted />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.blobUrl} alt="" className="aspect-square w-full rounded object-cover" />
              )}
              <div className="flex justify-between text-xs text-black/50 dark:text-white/50">
                <span>{c.type}</span>
                <span>{c.reviewState}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
