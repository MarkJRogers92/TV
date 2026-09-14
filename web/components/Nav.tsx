export const pageNames = [
  "Dashboard",
  "Channel",
  "Library",
  "Schedule",
  "Tunarr",
] as const;
export type PageName = (typeof pageNames)[number];

export function Nav({
  current,
  onNavigate,
}: {
  current: PageName;
  onNavigate: (page: PageName) => void;
}) {
  return (
    <nav aria-label="Main navigation">
      {pageNames.map((page) => (
        <a
          aria-current={current === page ? "page" : undefined}
          href={page === "Dashboard" ? "#/" : `#/${page.toLowerCase()}`}
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
