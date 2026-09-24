import WorkspaceAssistant from "@/components/workspace-assistant";

export default function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <>{children}<WorkspaceAssistant /></>;
}
