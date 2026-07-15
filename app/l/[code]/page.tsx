import { notFound, redirect } from "next/navigation";
import { decodeLockInviteCode } from "@/src/lock-invite";

type InvitePageProps = { params: Promise<{ code: string }> };

export default async function InvitePage({ params }: InvitePageProps) {
  const { code } = await params;
  const pactId = decodeLockInviteCode(code);
  if (pactId === null) notFound();

  redirect(`/lock/${pactId}`);
}
