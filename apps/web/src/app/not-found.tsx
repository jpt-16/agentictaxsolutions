import Link from "next/link";

export default function NotFound() {
  return (
    <div role="alert" className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-subtle">404</p>
      <h1 className="mt-2 text-xl font-semibold text-ink">We couldn’t find that page</h1>
      <p className="mt-1 text-muted">It may have been moved, or you may not have access to it.</p>
      <Link href="/" className="btn btn-primary mt-5">Back to dashboard</Link>
    </div>
  );
}
