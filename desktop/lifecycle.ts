export interface BeforeQuitEvent {
  preventDefault(): void;
}

/** Prevents repeated quit events from bypassing asynchronous resource cleanup. */
export function createBeforeQuitHandler(
  stop: () => Promise<void>,
  quit: () => void,
  onError: (error: unknown) => void = () => {},
): (event: BeforeQuitEvent) => Promise<void> | undefined {
  let shutdownPromise: Promise<void> | undefined;
  let quitIsAllowed = false;

  return (event) => {
    if (quitIsAllowed) return undefined;
    event.preventDefault();
    if (shutdownPromise) return shutdownPromise;

    let cleanup: Promise<void>;
    try {
      cleanup = stop();
    } catch (error) {
      cleanup = Promise.reject(error);
    }
    shutdownPromise = cleanup
      .catch(onError)
      .then(() => {
        quitIsAllowed = true;
        quit();
      });
    return shutdownPromise;
  };
}
