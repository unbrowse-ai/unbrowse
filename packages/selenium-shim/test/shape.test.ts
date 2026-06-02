import { test, expect, afterEach } from 'bun:test';
import sw, { Builder, WebDriver, WebElement, By, until, Key } from '../src/index.js';

// Parity: a selenium-webdriver caller's import surface must exist so the swap
// compiles and runs. All network-touching methods are exercised under
// UNBROWSE_DRYRUN='1' so the suite is fully deterministic and offline.

afterEach(() => {
  delete process.env.UNBROWSE_DRYRUN;
});

test('default export carries Builder/By/until/Key/WebDriver/WebElement', () => {
  expect(typeof sw.Builder).toBe('function');
  expect(typeof sw.WebDriver).toBe('function');
  expect(typeof sw.WebElement).toBe('function');
  expect(typeof sw.By).toBe('object');
  expect(typeof sw.until).toBe('object');
  expect(typeof sw.Key).toBe('object');
});

test('Builder is constructable and fluent', () => {
  const b = new Builder();
  expect(b.forBrowser('chrome')).toBe(b);
  expect(b.withCapabilities({ browserName: 'chrome' })).toBe(b);
  expect(b.setChromeOptions({ args: ['--headless'] })).toBe(b);
});

test('forBrowser().build() returns a driver with the core surface', async () => {
  const driver = await new Builder().forBrowser('chrome').build();
  for (const m of [
    'get',
    'getTitle',
    'getPageSource',
    'getCurrentUrl',
    'findElement',
    'findElements',
    'executeScript',
    'wait',
    'quit',
    'close',
  ]) {
    expect(typeof (driver as any)[m]).toBe('function');
  }
  await driver.quit();
});

test('By.css/.id/.xpath/.className/.name/.tagName/.linkText return locator objects', () => {
  const css = By.css('.foo');
  expect(css).toEqual({ using: 'css selector', value: '.foo' });

  const id = By.id('main');
  expect(id).toEqual({ using: 'css selector', value: '#main' });

  const xp = By.xpath('//div');
  expect(xp).toEqual({ using: 'xpath', value: '//div' });

  expect(By.className('btn')).toEqual({ using: 'css selector', value: '.btn' });
  expect(By.name('q').using).toBe('css selector');
  expect(By.tagName('a')).toEqual({ using: 'css selector', value: 'a' });
  expect(By.linkText('Home')).toEqual({ using: 'link text', value: 'Home' });
});

test('until exposes titleIs/titleContains/elementLocated/urlContains as condition factories', () => {
  for (const k of ['titleIs', 'titleContains', 'elementLocated', 'urlContains']) {
    expect(typeof (until as any)[k]).toBe('function');
  }
  const cond = until.titleContains('hello');
  expect(typeof cond.fn).toBe('function');
  expect(typeof cond.message).toBe('string');
});

test('Key exposes the special-key constants', () => {
  for (const k of ['ENTER', 'TAB', 'ESCAPE', 'RETURN', 'SHIFT', 'CONTROL']) {
    expect(typeof (Key as any)[k]).toBe('string');
  }
});

test('dryrun: get() does no network and yields deterministic empty page', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const driver = await new Builder().forBrowser('chrome').build();
    await driver.get('https://example.com/data');
    expect(await driver.getCurrentUrl()).toBe('https://example.com/data');
    expect(await driver.getPageSource()).toBe('');
    expect(await driver.getTitle()).toBe('');
    await driver.quit();
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('dryrun: findElement returns a WebElement; findElements is [] on empty body', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const driver = await new Builder().forBrowser('chrome').build();
    await driver.get('https://example.com/data');
    const el = await driver.findElement(By.css('h1'));
    expect(el).toBeInstanceOf(WebElement);
    for (const m of ['getText', 'click', 'sendKeys', 'getAttribute']) {
      expect(typeof (el as any)[m]).toBe('function');
    }
    expect(await driver.findElements(By.css('li'))).toEqual([]);
    await driver.quit();
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('dryrun: executeScript(document.title) resolves from the cached read surface', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const driver = await new Builder().forBrowser('chrome').build();
    await driver.get('https://example.com/data');
    expect(await driver.executeScript('return document.title')).toBe('');
    await driver.quit();
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});

test('dryrun: wait() resolves a satisfied condition without network', async () => {
  process.env.UNBROWSE_DRYRUN = '1';
  try {
    const driver = await new Builder().forBrowser('chrome').build();
    await driver.get('https://example.com/data');
    // empty title satisfies titleIs('')
    const ok = await driver.wait(until.titleIs(''), 1000);
    expect(ok).toBe(true);
    await driver.quit();
  } finally {
    delete process.env.UNBROWSE_DRYRUN;
  }
});
