import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { loadSharedPlanPage } from "../../../src/api/share";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(date);
}

async function SharedBody({ params }: { readonly params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const page = await loadSharedPlanPage(slug);
  if (page.status === "missing") notFound();
  if (page.status === "unconfigured") {
    return <p>Sharing is not available on this server.</p>;
  }
  const { view } = page;
  return (
    <>
      <h2>Shared plan</h2>
      <ol className="share-stops" data-hydrated={view.hydrated ? "true" : "false"}>
        {view.stops.map((stop) => (
          <li key={`${stop.placeId}-${stop.start}`} data-place-id={stop.placeId}>
            <time dateTime={stop.start}>{formatWhen(stop.start)}</time>
            <strong>{stop.name ?? stop.placeId}</strong>
            <p>{stop.why}</p>
          </li>
        ))}
      </ol>
      <p>
        <Link href="/">Plan another night</Link>
      </p>
    </>
  );
}

export default function SharedPlanPage({ params }: PageProps<"/s/[slug]">) {
  return (
    <main>
      <h1>Nightcap</h1>
      <Suspense fallback={<p>Loading the shared plan.</p>}>
        <SharedBody params={params} />
      </Suspense>
    </main>
  );
}
