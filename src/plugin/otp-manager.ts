type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

/**
 * OTP manager
 *
 * Maintains a long-lived OTP watcher across multiple `unbrowse_browse` calls so an OTP
 * can be auto-filled as soon as it arrives. Opt-in only (disabled by default).
 */
export function createOtpManager(opts: {
  logger: Logger;
  enableOtpAutoFill: boolean;
  ttlMs?: number;
}) {
  const { logger, enableOtpAutoFill } = opts;
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;

  let persistentOtpWatcher: any = null;
  let otpWatcherPage: any = null;
  let otpWatcherElementIndex: number | null = null;
  let otpWatcherTimeout: NodeJS.Timeout | null = null;

  function isOtpWatcherActive(): boolean {
    return !!persistentOtpWatcher;
  }

  async function startPersistentOtpWatcher(page: any, elementIndex: number) {
    if (!enableOtpAutoFill) {
      logger.info(`[unbrowse] OTP auto-fill disabled. Enable with config: enableOtpAutoFill: true`);
      return;
    }

    stopPersistentOtpWatcher();

    otpWatcherPage = page;
    otpWatcherElementIndex = elementIndex;

    const { startOTPWatcher } = await import("../otp-watcher.js");
    const { getElementByIndex } = await import("../dom-service.js");

    persistentOtpWatcher = startOTPWatcher(async (otp) => {
      logger.info(`[unbrowse] Auto-OTP: Received \"${otp.code}\" from ${otp.source}`);
      try {
        if (otpWatcherPage && otpWatcherElementIndex != null) {
          const el = await getElementByIndex(otpWatcherPage, otpWatcherElementIndex);
          if (el) {
            await el.click();
            await el.fill(otp.code);
            logger.info(`[unbrowse] Auto-OTP: Filled \"${otp.code}\" into element [${otpWatcherElementIndex}]`);
            persistentOtpWatcher?.clear();
          }
        }
      } catch (err) {
        logger.warn(`[unbrowse] Auto-OTP fill failed: ${(err as Error).message}`);
      }
    });

    otpWatcherTimeout = setTimeout(() => {
      logger.info(`[unbrowse] Auto-OTP watcher TTL expired (${Math.round(ttlMs / 1000)}s)`);
      stopPersistentOtpWatcher();
    }, ttlMs);
    otpWatcherTimeout.unref();

    logger.info(`[unbrowse] Persistent OTP watcher started for element [${elementIndex}] (TTL: ${Math.round(ttlMs / 1000)}s)`);
  }

  function stopPersistentOtpWatcher() {
    if (persistentOtpWatcher) {
      persistentOtpWatcher.stop();
      persistentOtpWatcher = null;
    }
    if (otpWatcherTimeout) {
      clearTimeout(otpWatcherTimeout);
      otpWatcherTimeout = null;
    }
    otpWatcherPage = null;
    otpWatcherElementIndex = null;
  }

  return {
    startPersistentOtpWatcher,
    stopPersistentOtpWatcher,
    isOtpWatcherActive,
  };
}

