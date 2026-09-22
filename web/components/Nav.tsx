export const pageNames = [
  "Dashboard",
  "Watch Live",
  "Channel",
  "Library",
  "Schedule",
  "Continuity",
  "Tunarr",
  "Wanted",
  "Integrations",
] as const;
export type PageName = (typeof pageNames)[number];

export function Nav({
  current,
  onNavigate,
}: {
  current: PageName;
  onNavigate: (page: PageName) => void;
}) {
  const hrefFor = (page: PageName) => {
    if (page === "Dashboard") return "#/";
    return `#/${page.toLowerCase().replaceAll(" ", "-")}`;
  };
  return (
    <nav aria-label="Main navigation">
      {pageNames.map((page) => (
        <a
          aria-current={current === page ? "page" : undefined}
          href={hrefFor(page)}
          key={page}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(page);
          }}
        >
          {page}
        </a>
      ))}
    </nav>
  );
}
