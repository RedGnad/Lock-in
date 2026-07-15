import { permanentRedirect } from "next/navigation";

type LegacyPactPageProps = { params: Promise<{ id: string }> };

export default async function LegacyPactPage({ params }: LegacyPactPageProps) {
  const { id } = await params;
  permanentRedirect(`/lock/${id}`);
}
