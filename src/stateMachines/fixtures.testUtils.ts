/** Sources with state-machine signals, shared by the scanner and command tests. */
export const FETCHER = `
export function Items() {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [open, setOpen] = useState(false);
  async function load() {
    setIsLoading(true);
    setHasError(false);
    try { await fetchItems(); } catch { setHasError(true); } finally { setIsLoading(false); }
  }
  // setOpen(true) only opens a panel
  return null;
}
`;

export const WORKER = `
class SyncWorker:
    def start(self):
        self.status = "running"
        self._running = True
    def fail(self):
        self.status = "error"
        self._running = False
    def finish(self):
        self.status = "done"
        self.is_dirty = True
    def reset(self):
        self.is_dirty = False
`;
