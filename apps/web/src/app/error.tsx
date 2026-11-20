"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
      <p className="mt-1 text-muted">The error has been logged. Try again, and contact support if it keeps happening.</p>
      <button className="btn btn-primary mt-5" onClick={reset}>Try again</button>
    </div>
  );
}
