import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProxyTabContent } from "@/components/settings/ProxyTabContent";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// This test only asserts which accordion sections EXIST, so stub every hook the
// tab pulls in — none of their behavior is under test here.
vi.mock("@/hooks/useProxyStatus", () => ({
  useProxyStatus: () => ({
    isRunning: false,
    takeoverStatus: {},
    startProxyServer: vi.fn(),
    stopWithRestore: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("@/hooks/useGlobalProxy", () => ({
  useGlobalProxyUrl: () => ({ data: null, isLoading: false }),
  useSetGlobalProxyUrl: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestProxy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScanProxies: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/query/idleWatch", () => ({
  useIdleWatchConfig: () => ({ data: undefined, isLoading: false }),
  useSaveIdleWatchConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useChannelIdleStatus: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/query/replay", () => ({
  useReplayStatus: () => ({ data: null, isLoading: false }),
  useReplayConfig: () => ({ data: undefined, isLoading: false }),
  useStartReplay: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useStopReplay: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveReplayConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  fetchReplaySnapshotInfo: vi.fn(),
}));
vi.mock("@/lib/query/provider", () => ({
  useProviders: () => ({ data: [], isLoading: false }),
}));

const settings = {
  failoverConfirmed: true,
  enableFailoverToggle: false,
} as never;

describe("ProxyTabContent sections", () => {
  it("exposes the replay and idle-watch entry points", () => {
    render(
      <ProxyTabContent settings={settings} onAutoSave={async () => true} />,
    );
    // Accordion triggers are present even while collapsed.
    expect(screen.getByText("replay.title")).toBeInTheDocument();
    expect(screen.getByText("idleWatch.title")).toBeInTheDocument();
  });
});
