import { permanentRedirect } from "next/navigation";

type LegacyLockPageProps = { params: Promise<{ id: string }> };

export default async function LegacyLockPage({ params }: LegacyLockPageProps) {
  const { id } = await params;
  permanentRedirect(`/lock/${id}`);
}
