// The only place that touches the page host. Today that is a plain browser tab;
// a Dynamics 365 web resource can set window.__CQA_HOST__ before the bundle loads.

export type HostAdapter = {
  apiBaseUrl: () => string;
  openExternal: (url: string) => void;
  saveFile: (name: string, content: string, type: string) => void;
  currentUserName: () => string | null;
};

declare global {
  interface Window {
    __CQA_CONFIG__?: { apiBaseUrl?: string };
    __CQA_HOST__?: Partial<HostAdapter>;
  }
}

const browserAdapter: HostAdapter = {
  apiBaseUrl: () =>
    (window.__CQA_CONFIG__?.apiBaseUrl ?? import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, ''),
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener');
  },
  saveFile: (name, content, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  },
  currentUserName: () => null,
};

export const host: HostAdapter = { ...browserAdapter, ...window.__CQA_HOST__ };
