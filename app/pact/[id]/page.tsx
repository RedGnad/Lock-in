import { PactDashboard } from "@/components/pact-dashboard";

export default async function PactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PactDashboard id={id} />;
}
