// One entry per reference site. Placeholders filled per prospect at serve time:
// [[NAME]] business name, [[PHONE]] (508) 555-0101, [[PHONE_DIGITS]] 5085550101,
// [[CITY]] Mashpee, [[STATE]] MA, [[TOWN]] Mashpee, MA, [[ASSET]] asset base URL.
const SERVICE_PAGES = (prefix, slugs) => slugs.map((s) => `${prefix}/${s}`);

module.exports = {
  'electrician-a': {
    repo: 'mattfarrel',
    trades: ['electrician'],
    // never send this design to prospects in the original client's own area
    avoidTowns: ['Marion', 'Mattapoisett', 'Wareham', 'Rochester', 'Fairhaven', 'New Bedford', 'Dartmouth', 'Acushnet', 'Middleborough', 'Carver', 'Plymouth', 'Bourne', 'Freetown', 'Lakeville', 'Westport'],
    pages: ['/', '/about', '/contact', '/services', ...SERVICE_PAGES('/services', ['residential-electrical', 'service-repair', 'generator-installation-service', 'panel-upgrades', 'lighting-solutions', 'ev-charger-installation', 'surge-protection'])],
    overrides: {
      'data/site.js': {
        name: '[[NAME]]', shortName: '[[NAME]]', phone: '[[PHONE]]', phoneRaw: '+1[[PHONE_DIGITS]]', license: '', licenseRaw: '',
        email: '', address: { street: '', city: '[[CITY]]', state: '[[STATE]]', zip: '' }, fullAddress: '[[TOWN]]',
        yearsExperience: '', founded: '', domain: '', social: { facebook: '#', google: '#' },
        tagline: 'Reliable. Professional. Power You Can Count On.',
      },
      'data/testimonials.js': [],
      'data/towns.js': [],
    },
    removeSelectors: ['.statbar', '.hero__trust', 'section:has(.promo-banner)', 'section:has(.testimonials-grid)', 'section:has(.town-index-grid)', '.hero__photo-badge'],
    removeLinksTo: ['/service-area'],
    extraCss: '.topbar svg,.hero__eyebrow svg{width:16px;height:16px;vertical-align:-3px}',
    removeBlocksMatching: ['MA Lic #', 'Years of Experience', 'Licensed & Insured$', '^Electrician in ', 'Proudly Serving'],
    replacements: [
      ["\\(508\\) 916-1980", '[[PHONE]]'], ["Licensed & Insured\\s*—\\s*(MA Lic #\\w+)?", 'Free estimates'],
      ["is a residential electrical contractor based at 73 County Road in Marion, Massachusetts\\. With\\s+years in the trade, Matt has built his business", 'is a residential electrical contractor serving [[TOWN]]. We built this business'],
      ["leaving the job site cleaner than he found it", 'leaving the job site cleaner than we found it'],
      ["Licensed and insured residential electrician based in Marion, MA, serving the South Coast since\\s*\\.", 'Residential electrician serving [[TOWN]] and nearby towns.'],
      ["All rights reserved\\.\\s*MA Lic #\\w+\\.?|All rights reserved\\.\\s*\\.", 'All rights reserved.'],
      ["Serving Marion & the South Coast", 'Serving [[CITY]] & nearby towns'], ["Marion, MA & The South Coast", '[[TOWN]] & nearby towns'],
      ["Marion, MA Based", 'Locally Based'], ["Serving the South Coast from Buzzards Bay to the Cape Cod Canal\\.?", 'Serving [[CITY]] and nearby towns.'],
      ["Local, licensed, and built on referrals", 'Local and built on referrals'],
      ["Twenty years of doing the job the right way", 'Doing the job the right way'],
      ["built this business on referrals, not ads", 'is built on referrals, not ads'],
      ["Matt Farrell Electrician", '[[NAME]]'], ["Matt Farrell", '[[NAME]]'],
      ["About Matt( Farrell)?", 'About Us'],
      ["Matt's", 'our'], ["\\bMatt\\b", 'our team'], ["\\bhe's\\b", "we're"], ["\\bhe\\b", 'we'], ["\\bhis\\b", 'our'],
      ["from Marion to the Cape Cod Canal", 'across [[CITY]] and nearby towns'],
      ["Marion, MA", '[[TOWN]]'], ["Marion", '[[CITY]]'],
      ["the South Coast", '[[CITY]] and nearby towns'], ["South Coast", 'local'],
      ["Cape Cod Canal|Sippican Harbor|Tabor Academy|Buzzards Bay", 'the area'],
      ["\\s*brings\\s+years of licensed electrical experience to every home", ' brings careful electrical work to every home'],
      ["backed by \\d+ years of hands-on experience", 'backed by real hands-on experience'],
      ["\\b(20|twenty) years\\b", 'years'], ["\\d+ Years in the Field", 'Experienced in the Field'], ["since 2006", ''], ["MA Lic #\\w+\\s*(—|-)?\\s*", ''],
      ["licensed, insured, and done to code", 'done to code'], ["Massachusetts licensed electrician", 'electrician'],
      ["(^|[.!?]\\s+)our team", '$1Our team'], ["(^|[.!?]\\s+)our ", '$1Our '], ["(^|[.!?]\\s+)we ", '$1We '],
      ["Licensed Electrician in", 'Electrician in'],
      ["\\s*years of licensed electrical work, based right in", ' — electrical work, based right in'],
      ["\\s*years of licensed electrical experience in ([^.]+)\\. Family-run, fully licensed and insured\\s*—\\s*\\.", ' Electrical work in $1.'],
      ["Licensed, insured electrician", 'Electrician'], ["Licensed residential", 'Residential'], ["\\blicensed\\b\\s*", ''],
      ["the area winters", 'New England winters'], ["Homes near the area", 'Homes around here'], ["near the area", 'around here'], ["Licensed and insured residential electrician", 'Residential electrician'],
    ],
    leakTerms: ['\\bMatt\\b', 'Lic #', 'licensed', '\\bhis\\b', 'the area\\b', 'Farrell', 'Marion', 'South Coast', '13765', '916-1980', 'mattfarrell', 'Karen S', 'Mattapoisett', '2006', '\\b20 years'],
  },
};
