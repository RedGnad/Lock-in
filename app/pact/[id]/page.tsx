import { redirect } from "next/navigation";

type LegacyPactPageProps = { params: Promise<{ id: string }> };

export default async function LegacyPactPage({ params }: LegacyPactPageProps) {
  const { id } = await params;
  redirect(`/lock/${id}`);
}
