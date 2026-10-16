import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CATEGORIES, CATEGORY_GROUPS, categoryLabel, detectCategory, getCategory, isCategoryKey } from '../../src/shared/categories';
import { allCurrencies } from '../../src/shared/currencies';

describe('detectCategory: the descriptions people actually type', () => {
  it.each([
    // The list from the spec review.
    ['燒肉晚餐', 'food.dining'],
    ['拉麵', 'food.dining'],
    ['藥妝', 'life.shopping'],
    ['全聯', 'food.groceries'],
    ['高鐵', 'transport.train'],
    ['Uber', 'transport.taxi'],
    ['Whole Foods', 'food.groceries'],
    ['IKEA', 'home.furniture'],
    ['Airbnb', 'travel.hotel'],
    ['lift tickets', 'travel.ski'],
    ['手搖飲', 'food.drinks'],
    ['7-11', 'food.groceries'],
    ['Shell gas', 'transport.gas'],
  ])('%s -> %s', (text, want) => {
    expect(detectCategory(text)).toBe(want);
  });

  it.each([
    ['晚餐', 'food.dining'],
    ['一蘭拉麵', 'food.dining'],
    ['居酒屋', 'food.dining'],
    ['早午餐', 'food.dining'],
    ['火鍋', 'food.dining'],
    ['啤酒', 'food.liquor'],
    ['星巴克', 'food.drinks'],
    ['珍奶', 'food.drinks'],
    ['家樂福', 'food.groceries'],
    ['好市多', 'food.groceries'],
    ['全家', 'food.groceries'],
    ['計程車', 'transport.taxi'],
    ['台鐵', 'transport.train'],
    ['捷運', 'transport.train'],
    ['新幹線', 'transport.train'],
    ['悠遊卡儲值', 'transport.train'],
    ['機票', 'transport.plane'],
    ['長榮航空', 'transport.plane'],
    ['租車', 'transport.car'],
    ['加油', 'transport.gas'],
    ['停車費', 'transport.parking'],
    ['飯店', 'travel.hotel'],
    ['酒店', 'travel.hotel'],
    ['民宿', 'travel.hotel'],
    ['溫泉旅館', 'travel.hotel'],
    ['門票', 'travel.activity'],
    ['迪士尼門票', 'travel.activity'],
    ['環球影城', 'travel.activity'],
    ['滑雪', 'travel.ski'],
    ['雪票', 'travel.ski'],
    ['伴手禮', 'travel.souvenir'],
    ['電影', 'entertainment.movies'],
    ['KTV', 'entertainment.music'],
    ['健身房', 'entertainment.sports'],
    ['房租', 'home.rent'],
    ['電費', 'utilities.electricity'],
    ['台電', 'utilities.electricity'],
    ['水費', 'utilities.water'],
    ['瓦斯費', 'utilities.gas'],
    ['網路費', 'utilities.internet'],
    ['中華電信', 'utilities.internet'],
    ['衛生紙', 'home.supplies'],
    ['大創', 'home.supplies'],
    ['唐吉訶德', 'life.shopping'],
    ['衣服', 'life.clothing'],
    ['紅包', 'life.gifts'],
    ['藥局', 'life.medical'],
    ['看醫生', 'life.medical'],
    ['旅平險', 'life.insurance'],
    ['簽證', 'life.taxes'],
    ['手續費', 'life.taxes'],
    ['寵物', 'home.pets'],
    ['垃圾袋', 'utilities.trash'],
  ])('zh: %s -> %s', (text, want) => {
    expect(detectCategory(text)).toBe(want);
  });

  it.each([
    ['Dinner at Ichiran', 'food.dining'],
    ['Breakfast', 'food.dining'],
    ['Sushi', 'food.dining'],
    ['Korean BBQ', 'food.dining'],
    ['beef noodles', 'food.dining'],
    ['Burgers', 'food.dining'],
    ['Uber Eats', 'food.dining'],
    ['Groceries', 'food.groceries'],
    ['Costco run', 'food.groceries'],
    ["Trader Joe's", 'food.groceries'],
    ['7-Eleven snacks', 'food.groceries'],
    ['Starbucks', 'food.drinks'],
    ['Boba', 'food.drinks'],
    ['Beers', 'food.liquor'],
    ['Wine', 'food.liquor'],
    ['Flight to Taipei', 'transport.plane'],
    ['Flights to Tokyo', 'transport.plane'],
    ['JR Pass', 'transport.train'],
    ['Shinkansen', 'transport.train'],
    ['Lyft', 'transport.taxi'],
    ['Taxis', 'transport.taxi'],
    ['Uber to airport', 'transport.taxi'],
    ['Car rental', 'transport.car'],
    ['Car rental + gas + toll', 'transport.car'],
    ['Tolls', 'transport.car'],
    ['Gas station', 'transport.gas'],
    ['Parking', 'transport.parking'],
    ['Hotel', 'travel.hotel'],
    ['Hotels', 'travel.hotel'],
    ['Hostel in Kyoto', 'travel.hotel'],
    ['Lift ticket', 'travel.ski'],
    ['Lift passes', 'travel.ski'],
    ['Museum tickets', 'travel.activity'],
    ['Concert tickets', 'travel.activity'],
    ['Souvenirs', 'travel.souvenir'],
    ['Movie tickets', 'entertainment.movies'],
    ['Netflix', 'entertainment.movies'],
    ['Spotify', 'entertainment.music'],
    ['Karaoke', 'entertainment.music'],
    ['Gym membership', 'entertainment.sports'],
    ['October rent', 'home.rent'],
    ['Electric bill', 'utilities.electricity'],
    ['Water bill', 'utilities.water'],
    ['Comcast', 'utilities.internet'],
    ['Phone bill', 'utilities.internet'],
    ['Laundry', 'home.services'],
    ['Toilet paper', 'home.supplies'],
    ['Home Depot', 'home.supplies'],
    ['Vet visit', 'home.pets'],
    ['Birthday gift', 'life.gifts'],
    ['Pharmacy', 'life.medical'],
    ['Tuition', 'life.education'],
    ['Travel insurance', 'life.insurance'],
    ['Visa fee', 'life.taxes'],
  ])('en: %s -> %s', (text, want) => {
    expect(detectCategory(text)).toBe(want);
  });
});

describe('detectCategory: matching rules', () => {
  it('ignores case and full-width letters', () => {
    expect(detectCategory('UBER')).toBe('transport.taxi');
    expect(detectCategory('ＩＫＥＡ')).toBe('home.furniture');
    expect(detectCategory('ｕｂｅｒ')).toBe('transport.taxi');
    expect(detectCategory('７－１１')).toBe('food.groceries');
  });

  it('matches Latin keywords only as whole words (with an optional plural)', () => {
    expect(detectCategory('team dinner')).toBe('food.dining'); // not "tea"
    expect(detectCategory('catering')).toBeNull(); // not "cat"
    expect(detectCategory('Barbecue')).toBeNull(); // not "bar"
    expect(detectCategory('banana')).toBeNull(); // not ANA
    expect(detectCategory('Room 3711')).toBeNull(); // not 711
    expect(detectCategory('Uber, then dinner')).toBe('food.dining'); // the longer keyword wins
  });

  it('prefers the longest keyword', () => {
    expect(detectCategory('居酒屋喝酒')).toBe('food.dining'); // 居酒屋 over 酒
    expect(detectCategory('酒店')).toBe('travel.hotel'); // 酒店 over 酒
    expect(detectCategory('飯店')).toBe('travel.hotel'); // 飯店 over 飯
    expect(detectCategory('藥妝店')).toBe('life.shopping'); // 藥妝 over 藥
    expect(detectCategory('環球影城門票')).toBe('travel.activity'); // a theme park, not a cinema
    expect(detectCategory('lift tickets and lunch')).toBe('travel.ski'); // lift ticket over tickets and lunch
  });

  it('returns null for empty or unknown text', () => {
    for (const s of ['', '   ', 'asdf', 'xyz123', '12345', '？？']) expect(detectCategory(s)).toBeNull();
  });

  it('property: only ever returns null or a known category, deterministically', () => {
    const words = fc.constantFrom('dinner', 'uber', 'tea', 'bar', 'lift', 'ticket', 'tickets', 'hotel', '晚餐', '酒', '店', '雪', 'x', ' ', '-', '7', '11', 'Ｏ', 'é');
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'grapheme', maxLength: 30 }), fc.array(words, { maxLength: 8 }).map(w => w.join(''))), s => {
        const r = detectCategory(s);
        if (r !== null) expect(isCategoryKey(r)).toBe(true);
        expect(detectCategory(s)).toBe(r);
        expect(r === null || (r !== 'payment' && r !== 'general')).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('getCategory, categoryLabel, isCategoryKey', () => {
  it('falls back to general for unknown, empty and missing keys', () => {
    for (const k of [undefined, null, '', 'nope', 'food', 'FOOD.DINING']) expect(getCategory(k).key).toBe('general');
    expect(getCategory('food.dining')).toEqual({ key: 'food.dining', parent: 'food', zh: '餐廳', en: 'Dining out', icon: 'dining', emoji: '🍽️' });
  });

  it('labels in both languages', () => {
    expect(categoryLabel('food.dining', 'zh-TW')).toBe('餐廳');
    expect(categoryLabel('food.dining', 'en')).toBe('Dining out');
    expect(categoryLabel('nope', 'zh-TW')).toBe('一般');
    expect(categoryLabel('nope', 'en')).toBe('General');
    expect(categoryLabel('payment', 'zh')).toBe('付款');
  });

  it('isCategoryKey', () => {
    expect(isCategoryKey('travel.ski')).toBe(true);
    expect(isCategoryKey('payment')).toBe(true);
    expect(isCategoryKey('travel')).toBe(false);
    expect(isCategoryKey('')).toBe(false);
  });
});

describe('category table', () => {
  it('has unique keys, valid parents and complete labels', () => {
    const keys = CATEGORIES.map(c => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const groups = new Set(CATEGORY_GROUPS.map(g => g.key));
    expect(groups.size).toBe(CATEGORY_GROUPS.length);
    for (const c of CATEGORIES) {
      expect(groups.has(c.parent)).toBe(true);
      if (c.key !== 'general' && c.key !== 'payment') expect(c.key.startsWith(c.parent + '.')).toBe(true);
      expect(c.zh.length).toBeGreaterThan(0);
      expect(c.en.length).toBeGreaterThan(0);
      expect(c.icon).toMatch(/^[a-z]+$/);
      expect(c.emoji.length).toBeGreaterThan(0);
    }
    expect(isCategoryKey('general')).toBe(true);
    expect(getCategory('payment').parent).toBe('other');
  });

  it('every group has at least one category', () => {
    for (const g of CATEGORY_GROUPS) expect(CATEGORIES.some(c => c.parent === g.key)).toBe(true);
  });

  it('Chinese labels use Traditional characters only (categories, groups and currency names)', () => {
    // Characters that exist only in Simplified Chinese; their Traditional forms are 飲雜貨機鐵車費電網藥醫險規禮娛樂門寵動養兒書裝戲運維務視話購貸帳單爾亞馬蘭羅韓歐鎊幣圓國銖盧魯謝納烏薩堅圖.
    const simplified = /[饮杂货机铁车费电网药医险规礼娱乐门宠动养儿书装戏运维务视话购贷帐单尔亚马兰罗韩欧镑币圆国铢卢鲁谢纳乌萨坚图]/;
    const labels = [...CATEGORIES.map(c => c.zh), ...CATEGORY_GROUPS.map(g => g.zh), ...allCurrencies().map(c => c.zh)];
    for (const zh of labels) expect(zh).not.toMatch(simplified);
  });
});
