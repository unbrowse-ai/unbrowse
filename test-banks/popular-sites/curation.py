"""Hand-curated, web-facing candidates for the Tranco-backed test bank.

The rank is never assigned here; build_inventory.py joins these domains to a
permanent Tranco snapshot. Categories and market labels are editorial test
sampling labels, not properties supplied by Tranco.
"""

CATEGORIES = {
    "search_portals": "google.com bing.com yahoo.com baidu.com yandex.ru duckduckgo.com naver.com sogou.com ecosia.org startpage.com qwant.com ask.com aol.com msn.com 163.com 126.com mail.ru wp.pl seznam.cz so.com 360.cn google.co.jp google.co.uk google.de google.com.br google.co.in yahoo.co.jp yandex.com".split(),
    "social_community": "facebook.com instagram.com x.com twitter.com reddit.com pinterest.com linkedin.com tiktok.com snapchat.com tumblr.com vk.com vk.ru ok.ru weibo.com threads.com bsky.app quora.com stackexchange.com discord.com telegram.org whatsapp.com line.me wechat.com zhihu.com douban.com kakaotalk.com nextdoor.com truthsocial.com mastodon.social".split(),
    "news_media": "nytimes.com theguardian.com cnn.com bbc.com bbc.co.uk reuters.com apnews.com washingtonpost.com wsj.com bloomberg.com forbes.com cnbc.com npr.org foxnews.com usatoday.com dailymail.co.uk independent.co.uk ft.com wired.com time.com techcrunch.com theverge.com cnet.com businessinsider.com elpais.com lemonde.fr bild.de focus.de nikkei.com globo.com uol.com.br indiatimes.com hindustantimes.com ndtv.com aljazeera.com abc.net.au smh.com.au straitstimes.com channelnewsasia.com scmp.com huffpost.com politico.com axios.com news.yahoo.com".split(),
    "commerce_marketplace": "amazon.com ebay.com walmart.com etsy.com temu.com shein.com aliexpress.com taobao.com tmall.com jd.com pinduoduo.com rakuten.co.jp mercadolibre.com mercadolivre.com.br flipkart.com shopee.co.id shopee.com.br lazada.sg tokopedia.com olx.com ozon.ru wildberries.ru avito.ru allegro.pl bol.com zalando.de asos.com target.com bestbuy.com homedepot.com ikea.com costco.com macys.com wayfair.com amazon.co.uk amazon.de amazon.co.jp amazon.in amazon.fr amazon.ca ebay.co.uk ebay.de mobile.de craigslist.org carousell.sg".split(),
    "finance_payments": "paypal.com stripe.com visa.com mastercard.com chase.com bankofamerica.com capitalone.com wellsfargo.com citibank.com americanexpress.com hsbc.com barclays.co.uk santander.com sberbank.ru tinkoff.ru revolut.com wise.com robinhood.com coinbase.com binance.com tradingview.com investing.com finance.yahoo.com intuit.com schwab.com fidelity.com vanguard.com icicibank.com hdfcbank.com dbs.com.sg ocbc.com uob.com.sg".split(),
    "travel_transport": "booking.com airbnb.com tripadvisor.com expedia.com hotels.com agoda.com kayak.com skyscanner.net trip.com makemytrip.com irctc.co.in uber.com lyft.com grab.com gojek.com maps.google.com openstreetmap.org marriott.com hilton.com delta.com united.com aa.com southwest.com ryanair.com easyjet.com emirates.com singaporeair.com qatarairways.com airasia.com trainline.com".split(),
    "video_music": "youtube.com netflix.com spotify.com twitch.tv vimeo.com dailymotion.com primevideo.com disneyplus.com hulu.com hbomax.com max.com soundcloud.com deezer.com tidal.com apple.com bilibili.com iqiyi.com youku.com douyin.com tiktok.com crunchyroll.com imdb.com rottentomatoes.com hbo.com peacocktv.com paramountplus.com bandcamp.com tv.apple.com ivi.ru rutube.ru".split(),
    "gaming": "roblox.com steampowered.com steamcommunity.com epicgames.com ea.com playstation.com xbox.com nintendo.com riotgames.com minecraft.net chess.com lichess.org ign.com gamespot.com gamepass.com supercell.com unity.com unity3d.com ubisoft.com battle.net ea.com itch.io kongregate.com poki.com crazygames.com".split(),
    "education_research": "wikipedia.org britannica.com wikimedia.org archive.org arxiv.org researchgate.net sciencedirect.com nature.com springer.com wiley.com ieee.org mit.edu harvard.edu stanford.edu berkeley.edu cornell.edu coursera.org edx.org udemy.com khanacademy.org duolingo.com quizlet.com academia.edu jstor.org scholar.google.com cambridge.org oxford.ac.uk nih.gov nasa.gov ted.com".split(),
    "developer_technical": "github.com gitlab.com stackoverflow.com python.org npmjs.com pypi.org rust-lang.org docker.com kubernetes.io nodejs.org php.net mysql.com postgresql.org sourceforge.net huggingface.co developer.mozilla.org w3.org ietf.org rfc-editor.org apache.org nginx.org ubuntu.com debian.org redhat.com digitalocean.com vercel.com netlify.com cloudflare.com aws.amazon.com azure.microsoft.com developers.google.com".split(),
    "productivity_saas": "microsoft.com office.com outlook.com gmail.com google.com dropbox.com box.com notion.so slack.com zoom.us webex.com canva.com figma.com miro.com trello.com asana.com monday.com atlassian.com salesforce.com hubspot.com zendesk.com shopify.com wix.com squarespace.com wordpress.com wordpress.org medium.com substack.com calendly.com jotform.com surveymonkey.com adobe.com grammarly.com deepl.com chatgpt.com claude.ai perplexity.ai".split(),
    "government_health": "who.int un.org europa.eu www.gov.uk service.gov.uk usa.gov irs.gov usps.com cdc.gov fda.gov noaa.gov nist.gov loc.gov worldbank.org gov.sg cpf.gov.sg imda.gov.sg gov.in india.gov.in www.gov.br ca.gov gov.au ato.gov.au nhs.uk mayoclinic.org webmd.com healthline.com medlineplus.gov whitehouse.gov census.gov".split(),
    "consumer_technology": "samsung.com apple.com huawei.com xiaomi.com mi.com dell.com hp.com lenovo.com nvidia.com intel.com amd.com asus.com sony.com lg.com oppo.com vivo.com.cn oneplus.com motorola.com canon.com nikon.com logitech.com tp-link.com cisco.com oracle.com ibm.com autodesk.com meta.com openai.com anthropic.com".split(),
    "reference_lifestyle": "weather.com accuweather.com yelp.com zillow.com indeed.com glassdoor.com goodreads.com fandom.com merriam-webster.com dictionary.com wiktionary.org pinterest.com unsplash.com pexels.com pixabay.com flickr.com behance.net deviantart.com etsy.com allrecipes.com foodnetwork.com tripadvisor.com speedtest.net fast.com 2gis.com maps.google.com".split(),
}

# Labels denote the main localized market of this host, not company domicile.
MARKET_BY_SUFFIX = {
    ".ru": "RU", ".cn": "CN", ".com.cn": "CN", ".jp": "JP",
    ".co.jp": "JP", ".de": "DE", ".fr": "FR", ".co.uk": "UK",
    ".uk": "UK", ".com.br": "BR", ".br": "BR", ".co.in": "IN",
    ".in": "IN", ".sg": "SG", ".com.sg": "SG", ".id": "ID",
    ".co.id": "ID", ".com.au": "AU", ".au": "AU", ".pl": "PL",
    ".cz": "CZ", ".co.za": "ZA", ".es": "ES", ".it": "IT",
}

MARKET_OVERRIDES = {
    "baidu.com": "CN", "bilibili.com": "CN", "weibo.com": "CN",
    "taobao.com": "CN", "tmall.com": "CN", "jd.com": "CN",
    "pinduoduo.com": "CN", "zhihu.com": "CN", "douban.com": "CN",
    "douyin.com": "CN", "iqiyi.com": "CN", "youku.com": "CN",
    "qq.com": "CN", "wechat.com": "CN", "sogou.com": "CN",
    "so.com": "CN", "163.com": "CN", "126.com": "CN",
    "naver.com": "KR", "kakaotalk.com": "KR", "rakuten.com": "JP",
    "mercadolibre.com": "LATAM", "allegro.pl": "PL", "grab.com": "SEA",
    "gojek.com": "ID", "lazada.sg": "SEA", "tokopedia.com": "ID",
    "shopee.co.id": "ID", "shopee.com.br": "BR", "carousell.sg": "SEA",
    "makemytrip.com": "IN", "flipkart.com": "IN", "hindustantimes.com": "IN",
    "ndtv.com": "IN", "indiatimes.com": "IN", "irctc.co.in": "IN",
    "globo.com": "BR", "uol.com.br": "BR", "elpais.com": "ES",
    "lemonde.fr": "FR", "nikkei.com": "JP", "scmp.com": "HK",
    "channelnewsasia.com": "SG", "straitstimes.com": "SG",
    "sberbank.ru": "RU", "tinkoff.ru": "RU", "ozon.ru": "RU",
    "wildberries.ru": "RU", "avito.ru": "RU", "ivi.ru": "RU",
    "rutube.ru": "RU", "2gis.com": "RU", "seznam.cz": "CZ",
    "wp.pl": "PL", "bol.com": "NL", "qwant.com": "FR",
    "argos.co.uk": "UK", "gov.sg": "SG", "cpf.gov.sg": "SG",
}


def market_for(domain):
    if domain in MARKET_OVERRIDES:
        return MARKET_OVERRIDES[domain]
    for suffix in sorted(MARKET_BY_SUFFIX, key=len, reverse=True):
        if domain.endswith(suffix):
            return MARKET_BY_SUFFIX[suffix]
    return "GLOBAL"
