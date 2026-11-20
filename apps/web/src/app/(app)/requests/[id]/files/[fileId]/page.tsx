import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Download, Eye } from "lucide-react";
import { NotFoundError, previewFile, UploadRejectedError } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { fileDeps } from "@/lib/files";
import { Card, PageHeader, cn } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "File preview" };

const colLetter = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const isNumeric = (v: string) => /^-?[\d,]*\.?\d+%?$/.test(v.trim()) && v.trim() !== "";
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export default async function FilePreviewPage({ params, searchParams }: {
  params: Promise<{ id: string; fileId: string }>; searchParams: Promise<{ sheet?: string }>;
}) {
  const ctx = await requireContext();
  const { id, fileId } = await params;
  const { sheet } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(fileId)) notFound();

  let data;
  try { data = await previewFile(ctx, fileDeps(), fileId, sheet?.slice(0, 100)); }
  catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof UploadRejectedError) {
      return (<><PageHeader crumbs={[{ href: `/requests/${id}`, label: "Request" }, { label: "File" }]} title="Preview unavailable" subtitle={e.message} actions={<a className="btn btn-primary" href={`/api/files/${fileId}`}><Download size={14} aria-hidden /> Download</a>} /></>);
    }
    throw e;
  }
  const { preview: p } = data;
  const header = p.rows[0] ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ href: "/requests", label: "Information requests" }, { href: `/requests/${id}`, label: "Request" }, { label: data.name }]}
        title={data.name}
        subtitle={<span className="inline-flex items-center gap-1.5"><Eye size={14} aria-hidden /> Read-only preview · {size(data.size)} · this view is recorded in the audit history</span>}
        actions={<a className="btn btn-secondary" href={`/api/files/${fileId}`}><Download size={14} aria-hidden /> Download original</a>}
      />

      {(p.truncatedRows || p.truncatedCols) && (
        <p role="status" className="mb-4 flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-[13px]" style={{ background: "var(--amber-bg)", color: "var(--amber-fg)" }}>
          <AlertTriangle size={16} className="mt-0.5 flex-none" aria-hidden />
          Showing the first {p.rows.length} of {p.totalRows} rows and {Math.min(p.totalCols, header.length)} of {p.totalCols} columns. Download the original to see everything.
        </p>
      )}

      <Card>
        {p.sheets.length > 1 && (
          <nav aria-label="Sheets" className="flex flex-wrap gap-1 border-b border-line px-3 py-2">
            {p.sheets.map((s) => (
              <Link key={s.name} href={`/requests/${id}/files/${fileId}?sheet=${encodeURIComponent(s.name)}`} aria-current={s.name === p.active ? "page" : undefined}
                className={cn("rounded-md px-2.5 py-1 text-[13px] font-medium", s.name === p.active ? "bg-accentsoft text-accent" : "text-muted hover:bg-surface2 hover:text-ink")}>
                {s.name} <span className="tnum text-[11px] opacity-70">{s.rows}×{s.cols}</span>
              </Link>
            ))}
          </nav>
        )}
        {p.rows.length === 0 ? <p className="px-5 py-10 text-center text-muted">This sheet is empty.</p> : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 w-10 border-b border-r border-line bg-surface2 px-2 py-1.5" aria-label="Row" />
                  {header.map((_, c) => <th key={c} scope="col" className="sticky top-0 z-10 min-w-[96px] border-b border-r border-line bg-surface2 px-3 py-1.5 text-center text-[11px] font-semibold text-muted">{colLetter(c)}</th>)}
                </tr>
              </thead>
              <tbody>
                {p.rows.map((row, r) => (
                  <tr key={r} id={`r${r + 1}`} className={cn("target-row", r === 0 && "font-semibold")}>
                    <th scope="row" className="tnum sticky left-0 border-b border-r border-line bg-surface2 px-2 py-1 text-right text-[11px] font-medium text-subtle">{r + 1}</th>
                    {header.map((_, c) => {
                      const v = row[c] ?? "";
                      return <td key={c} className={cn("max-w-[280px] truncate border-b border-r border-line px-3 py-1 text-ink", isNumeric(v) && "tnum text-right")} title={v}>{v}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
