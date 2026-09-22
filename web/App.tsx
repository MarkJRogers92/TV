import { useEffect, useState } from "react";
import { markTvApi } from "./api";
import { Nav, type PageName } from "./components/Nav";
import { ChannelEditor } from "./pages/ChannelEditor";
import { Continuity } from "./pages/Continuity";
import { Dashboard } from "./pages/Dashboard";
import { Integrations } from "./pages/Integrations";
import { Library } from "./pages/Library";
import { Schedule } from "./pages/Schedule";
import { Tunarr } from "./pages/Tunarr";
import { Wanted } from "./pages/Wanted";
import { WatchLive } from "./pages/WatchLive";
import type { Channel } from "./types";
import "./styles.css";

const routePages: Record<string, PageName> = {
  "watch-live": "Watch Live",
  channel: "Channel",
  library: "Library",
  schedule: "Schedule",
  continuity: "Continuity",
  tunarr: "Tunarr",
  wanted: "Wanted",
  integrations: "Integrations",
};
const pageFromHash = (): PageName =>
  routePages[window.location.hash.replace(/^#\//, "")] ?? "Dashboard";
const hrefForPage = (page: PageName) =>
  page === "Dashboard"
    ? "#/"
    : `#/${page.toLowerCase().replaceAll(" ", "-")}`;

export function App() {
  const [page, setPage] = useState<PageName>(() => pageFromHash());
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState("marktv-laughs");
  useEffect(() => {
    markTvApi
      .listChannels()
      .then((loaded) => {
        setChannels(loaded);
        if (
          loaded.length &&
          !loaded.some((channel) => channel.id === channelId)
        )
          setChannelId(loaded[0].id);
      })
      .catch(() => undefined);
  }, [channelId]);
  useEffect(() => {
    const route = () => setPage(pageFromHash());
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, []);
  const navigate = (next: PageName) => {
    window.location.hash = hrefForPage(next);
    setPage(next);
  };
  const content =
    page === "Dashboard" ? (
      <Dashboard channelId={channelId} />
    ) : page === "Watch Live" ? (
      <WatchLive channelId={channelId} />
    ) : page === "Channel" ? (
      <ChannelEditor channelId={channelId} />
    ) : page === "Library" ? (
      <Library />
    ) : page === "Schedule" ? (
      <Schedule channelId={channelId} />
    ) : page === "Continuity" ? (
      <Continuity channelId={channelId} />
    ) : page === "Wanted" ? (
      <Wanted />
    ) : page === "Integrations" ? (
      <Integrations />
    ) : (
      <Tunarr />
    );
  return (
    <main>
      <header>
        <div>
          <h1>MarkTV</h1>
          <p>Local linear programming studio</p>
        </div>
        <Nav current={page} onNavigate={navigate} />
      </header>
      <div className="channel-picker">
        <label>
          Selected channel
          <select
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
          >
            {channels.length ? (
              channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name} · {channel.number}
                </option>
              ))
            ) : (
              <option value="marktv-laughs">MarkTV Laughs · 7</option>
            )}
          </select>
        </label>
      </div>
      {content}
    </main>
  );
}
