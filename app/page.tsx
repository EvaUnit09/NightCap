import { Suspense } from "react";

import { RequestScreen } from "./request-screen";

function itineraryParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.length === 0) return undefined;
  return raw;
}

async function PlannedNight({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const query = await searchParams;
  return <RequestScreen itineraryId={itineraryParam(query.itinerary)} />;
}

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main>
      <h1>Nightcap</h1>
      <Suspense fallback={null}>
        <PlannedNight searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
