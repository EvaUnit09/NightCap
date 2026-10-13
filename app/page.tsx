import { RequestScreen } from "./request-screen";

function itineraryParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.length === 0) return undefined;
  return raw;
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const query = await searchParams;
  return (
    <main>
      <h1>Nightcap</h1>
      <RequestScreen itineraryId={itineraryParam(query.itinerary)} />
    </main>
  );
}
