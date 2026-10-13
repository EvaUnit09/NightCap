import Link from "next/link";

export default function SharedPlanMissing() {
  return (
    <main>
      <h1>Nightcap</h1>
      <p>This shared plan was not found.</p>
      <Link href="/">Plan a night</Link>
    </main>
  );
}
