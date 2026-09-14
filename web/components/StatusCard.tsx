import type { ReactNode } from "react";

export function StatusCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <article className="status-card">
      <h2>{title}</h2>
      <div>{children}</div>
    </article>
  );
}
