import { notFound } from "next/navigation";
import { DeploymentConsole } from "@/components/deployment-console";

export default function DeployPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DeploymentConsole />;
}
