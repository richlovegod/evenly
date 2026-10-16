// Expense categories (modeled on Splitwise's tree, with a few travel and Taiwan-specific
// additions) and keyword detection from the description.

export interface Category {
  key: string;
  parent: string;
  zh: string;
  en: string;
  /** Icon name for the web app's icon set; `emoji` is the fallback. */
  icon: string;
  emoji: string;
}

export interface CategoryGroup {
  key: string;
  zh: string;
  en: string;
}

export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  { key: 'food', zh: '飲食', en: 'Food and drink' },
  { key: 'transport', zh: '交通', en: 'Transportation' },
  { key: 'travel', zh: '旅行', en: 'Travel' },
  { key: 'entertainment', zh: '娛樂', en: 'Entertainment' },
  { key: 'home', zh: '居家', en: 'Home' },
  { key: 'utilities', zh: '水電網路', en: 'Utilities' },
  { key: 'life', zh: '生活', en: 'Life' },
  { key: 'other', zh: '其他', en: 'Other' },
];

export const CATEGORIES: readonly Category[] = [
  { key: 'food.dining', parent: 'food', zh: '餐廳', en: 'Dining out', icon: 'dining', emoji: '🍽️' },
  { key: 'food.groceries', parent: 'food', zh: '超市雜貨', en: 'Groceries', icon: 'groceries', emoji: '🛒' },
  { key: 'food.drinks', parent: 'food', zh: '飲料咖啡', en: 'Coffee and drinks', icon: 'coffee', emoji: '☕' },
  { key: 'food.liquor', parent: 'food', zh: '酒', en: 'Liquor', icon: 'liquor', emoji: '🍺' },
  { key: 'food.other', parent: 'food', zh: '其他飲食', en: 'Food, other', icon: 'food', emoji: '🍱' },

  { key: 'transport.plane', parent: 'transport', zh: '機票', en: 'Plane', icon: 'plane', emoji: '✈️' },
  { key: 'transport.train', parent: 'transport', zh: '火車捷運公車', en: 'Bus and train', icon: 'train', emoji: '🚆' },
  { key: 'transport.taxi', parent: 'transport', zh: '計程車', en: 'Taxi', icon: 'taxi', emoji: '🚕' },
  { key: 'transport.car', parent: 'transport', zh: '租車', en: 'Car', icon: 'car', emoji: '🚗' },
  { key: 'transport.gas', parent: 'transport', zh: '油錢', en: 'Gas and fuel', icon: 'fuel', emoji: '⛽' },
  { key: 'transport.parking', parent: 'transport', zh: '停車', en: 'Parking', icon: 'parking', emoji: '🅿️' },
  { key: 'transport.bicycle', parent: 'transport', zh: '單車', en: 'Bicycle', icon: 'bicycle', emoji: '🚲' },
  { key: 'transport.other', parent: 'transport', zh: '其他交通', en: 'Transportation, other', icon: 'transport', emoji: '🚌' },

  { key: 'travel.hotel', parent: 'travel', zh: '住宿', en: 'Lodging', icon: 'hotel', emoji: '🏨' },
  { key: 'travel.activity', parent: 'travel', zh: '門票活動', en: 'Tickets and activities', icon: 'ticket', emoji: '🎟️' },
  { key: 'travel.ski', parent: 'travel', zh: '滑雪', en: 'Ski and snow', icon: 'ski', emoji: '⛷️' },
  { key: 'travel.souvenir', parent: 'travel', zh: '伴手禮', en: 'Souvenirs', icon: 'gift', emoji: '🎁' },
  { key: 'travel.other', parent: 'travel', zh: '其他旅行', en: 'Travel, other', icon: 'luggage', emoji: '🧳' },

  { key: 'entertainment.movies', parent: 'entertainment', zh: '電影', en: 'Movies', icon: 'movie', emoji: '🎬' },
  { key: 'entertainment.music', parent: 'entertainment', zh: '音樂', en: 'Music', icon: 'music', emoji: '🎵' },
  { key: 'entertainment.games', parent: 'entertainment', zh: '遊戲', en: 'Games', icon: 'games', emoji: '🎮' },
  { key: 'entertainment.sports', parent: 'entertainment', zh: '運動', en: 'Sports', icon: 'sports', emoji: '🏀' },
  { key: 'entertainment.other', parent: 'entertainment', zh: '其他娛樂', en: 'Entertainment, other', icon: 'party', emoji: '🎉' },

  { key: 'home.rent', parent: 'home', zh: '房租', en: 'Rent', icon: 'rent', emoji: '🏠' },
  { key: 'home.mortgage', parent: 'home', zh: '房貸', en: 'Mortgage', icon: 'mortgage', emoji: '🏦' },
  { key: 'home.furniture', parent: 'home', zh: '家具', en: 'Furniture', icon: 'furniture', emoji: '🛋️' },
  { key: 'home.electronics', parent: 'home', zh: '電器', en: 'Electronics', icon: 'electronics', emoji: '📺' },
  { key: 'home.supplies', parent: 'home', zh: '日用品', en: 'Household supplies', icon: 'supplies', emoji: '🧻' },
  { key: 'home.maintenance', parent: 'home', zh: '修繕', en: 'Maintenance', icon: 'tools', emoji: '🔧' },
  { key: 'home.services', parent: 'home', zh: '居家服務', en: 'Services', icon: 'services', emoji: '🧹' },
  { key: 'home.pets', parent: 'home', zh: '寵物', en: 'Pets', icon: 'pets', emoji: '🐾' },
  { key: 'home.other', parent: 'home', zh: '其他居家', en: 'Home, other', icon: 'home', emoji: '🏡' },

  { key: 'utilities.electricity', parent: 'utilities', zh: '電費', en: 'Electricity', icon: 'electricity', emoji: '💡' },
  { key: 'utilities.water', parent: 'utilities', zh: '水費', en: 'Water', icon: 'water', emoji: '💧' },
  { key: 'utilities.gas', parent: 'utilities', zh: '瓦斯暖氣', en: 'Heat and gas', icon: 'heat', emoji: '🔥' },
  { key: 'utilities.internet', parent: 'utilities', zh: '網路電話', en: 'TV, phone and internet', icon: 'wifi', emoji: '📶' },
  { key: 'utilities.trash', parent: 'utilities', zh: '垃圾清運', en: 'Trash', icon: 'trash', emoji: '🗑️' },
  { key: 'utilities.cleaning', parent: 'utilities', zh: '清潔', en: 'Cleaning', icon: 'cleaning', emoji: '🧽' },
  { key: 'utilities.other', parent: 'utilities', zh: '其他帳單', en: 'Utilities, other', icon: 'bill', emoji: '🧾' },

  { key: 'life.shopping', parent: 'life', zh: '購物', en: 'Shopping', icon: 'shopping', emoji: '🛍️' },
  { key: 'life.clothing', parent: 'life', zh: '服飾', en: 'Clothing', icon: 'clothing', emoji: '👕' },
  { key: 'life.gifts', parent: 'life', zh: '禮物', en: 'Gifts', icon: 'gift', emoji: '🎁' },
  { key: 'life.medical', parent: 'life', zh: '醫療藥品', en: 'Medical', icon: 'medical', emoji: '💊' },
  { key: 'life.education', parent: 'life', zh: '教育', en: 'Education', icon: 'education', emoji: '📚' },
  { key: 'life.childcare', parent: 'life', zh: '育兒', en: 'Childcare', icon: 'childcare', emoji: '🍼' },
  { key: 'life.insurance', parent: 'life', zh: '保險', en: 'Insurance', icon: 'insurance', emoji: '🛡️' },
  { key: 'life.taxes', parent: 'life', zh: '稅金規費', en: 'Taxes and fees', icon: 'taxes', emoji: '🏛️' },
  { key: 'life.other', parent: 'life', zh: '其他生活', en: 'Life, other', icon: 'life', emoji: '✨' },

  { key: 'general', parent: 'other', zh: '一般', en: 'General', icon: 'general', emoji: '🧾' },
  { key: 'payment', parent: 'other', zh: '付款', en: 'Payment', icon: 'payment', emoji: '💸' },
];

const BY_KEY = new Map(CATEGORIES.map(c => [c.key, c]));

export function getCategory(key: string | undefined | null): Category {
  return (key && BY_KEY.get(key)) || BY_KEY.get('general')!;
}

export function isCategoryKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function categoryLabel(key: string, locale: string): string {
  const c = getCategory(key);
  return locale.startsWith('zh') ? c.zh : c.en;
}

/** Keywords (lowercase) per category. Longer keywords win over shorter ones. */
const KEYWORDS: Record<string, string[]> = {
  'food.dining': ['dinner', 'lunch', 'breakfast', 'brunch', 'restaurant', 'meal', 'ramen', 'sushi', 'bbq', 'burger', 'pizza', 'pho', 'noodle', 'curry', 'hot pot', 'izakaya', 'tacos', 'dim sum', 'uber eats', 'ubereats',
    '晚餐', '午餐', '早餐', '早午餐', '宵夜', '餐廳', '吃飯', '聚餐', '拉麵', '燒肉', '火鍋', '壽司', '居酒屋', '牛排', '烤肉', '便當', '小吃', '咖哩', '麵', '飯', '鍋', '餐', '吃'],
  'food.groceries': ['grocer', 'grocery', 'groceries', 'whole foods', 'costco', 'trader joe', 'safeway', 'qfc', 'kroger', 'walmart', 'target', 't&t', 'h mart', '99 ranch', 'uwajimaya', 'aldi', 'supermarket', 'market',
    '超市', '全聯', '家樂福', '好市多', '市場', '菜', '水果', '雜貨', '超商', '7-11', '711', '7-eleven', '全家', '便利商店', 'lawson', 'familymart', 'seven'],
  'food.drinks': ['coffee', 'starbucks', 'cafe', 'latte', 'boba', 'bubble tea', 'tea', 'juice', 'smoothie', '咖啡', '星巴克', '飲料', '手搖', '珍奶', '奶茶', '茶'],
  'food.liquor': ['beer', 'wine', 'sake', 'soju', 'cocktail', 'bar', 'pub', 'whisky', 'whiskey', 'liquor', '酒', '啤酒', '紅酒', '清酒', '調酒', '酒吧'],
  'transport.plane': ['flight', 'airline', 'airfare', 'plane', 'eva air', 'china airlines', 'starlux', 'alaska air', 'delta', 'united', 'jal', 'ana', '機票', '航空', '飛機', '長榮', '華航', '星宇'],
  'transport.train': ['train', 'subway', 'metro', 'bus', 'shinkansen', 'jr pass', 'mrt', 'amtrak', 'ferry', 'transit', 'suica', 'icoca', 'orca', '高鐵', '台鐵', '火車', '捷運', '地鐵', '公車', '巴士', '新幹線', '電車', '渡輪', '悠遊卡'],
  'transport.taxi': ['uber', 'lyft', 'taxi', 'cab', 'grab', 'didi', 'go taxi', 'airport transfer', 'shuttle', '計程車', '小黃', '叫車', '滴滴', '接送', '包車'],
  'transport.car': ['car rental', 'rental car', 'hertz', 'avis', 'enterprise', 'budget', 'sixt', 'turo', 'toll', 'toyota rent', '租車', '過路費', '高速公路', 'etc'],
  'transport.gas': ['gas station', 'fuel', 'petrol', 'gasoline', 'shell', 'chevron', 'arco', 'ev charging', '加油', '油錢', '汽油', '充電'],
  'transport.parking': ['parking', 'valet', '停車'],
  'travel.hotel': ['hotel', 'airbnb', 'hostel', 'motel', 'lodging', 'resort', 'inn', 'ryokan', 'condo', 'cabin', 'booking.com', 'agoda', '住宿', '飯店', '旅館', '民宿', '酒店', '旅店', '溫泉旅館', '訂房'],
  'travel.ski': ['ski', 'lift ticket', 'lift pass', 'snowboard', 'ikon', 'epic pass', 'rental skis', 'lesson', '滑雪', '雪票', '纜車', '雪具', '雪板', '雪場'],
  'travel.activity': ['ticket', 'tickets', 'tour', 'museum', 'admission', 'entrance', 'disney', 'universal', 'show', 'concert', '門票', '入場', '博物館', '樂園', '環球影城', '導覽', '行程', '展覽', '演唱會'],
  'travel.souvenir': ['souvenir', 'omiyage', '伴手禮', '紀念品', '名產'],
  'entertainment.movies': ['movie', 'movie ticket', 'cinema', 'netflix', 'disney+', 'hbo', '電影', '影城'],
  'entertainment.music': ['spotify', 'apple music', 'karaoke', 'ktv', '唱歌', '音樂'],
  'entertainment.games': ['game', 'steam', 'nintendo', 'playstation', 'xbox', '遊戲', '桌遊'],
  'entertainment.sports': ['gym', 'golf', 'tennis', 'climbing', 'yoga', 'bowling', 'swim', 'hike', '健身', '高爾夫', '網球', '攀岩', '瑜伽', '保齡球', '游泳', '球'],
  'home.rent': ['rent', '房租', '租金'],
  'home.mortgage': ['mortgage', '房貸'],
  'home.furniture': ['ikea', 'furniture', 'sofa', 'mattress', '家具', '沙發', '床墊', '宜家'],
  'home.electronics': ['best buy', 'apple store', 'electronics', 'tv', 'laptop', '電器', '家電', '3c'],
  'home.supplies': ['household', 'toilet paper', 'detergent', 'home depot', 'lowes', 'daiso', '日用品', '衛生紙', '洗衣精', '大創', '生活用品'],
  'home.maintenance': ['repair', 'plumber', 'maintenance', '修理', '修繕', '水電工'],
  'home.services': ['cleaning service', 'maid', 'laundry', 'dry clean', '清潔服務', '洗衣', '乾洗'],
  'home.pets': ['pet', 'vet', 'dog', 'cat', 'petco', 'chewy', '寵物', '獸醫', '貓', '狗'],
  'utilities.electricity': ['electric', 'electricity', 'pse', 'pg&e', 'power bill', '電費', '台電'],
  'utilities.water': ['water bill', 'water', 'sewer', '水費'],
  'utilities.gas': ['gas bill', 'heating', 'puget sound energy', '瓦斯', '暖氣'],
  'utilities.internet': ['internet', 'wifi', 'comcast', 'xfinity', 'verizon', 't-mobile', 'att', 'phone bill', 'esim', 'sim card', 'pocket wifi', '網路', '電話費', '手機', '網卡', '中華電信', 'sim卡'],
  'utilities.trash': ['trash', 'garbage', 'recycling', '垃圾'],
  'utilities.cleaning': ['cleaning', 'cleaner', '清潔'],
  'life.shopping': ['amazon', 'shopping', 'mall', 'uniqlo', 'don quijote', 'donki', 'outlet', '購物', '唐吉訶德', '百貨', '藥妝', '逛街', '買'],
  'life.clothing': ['clothes', 'clothing', 'shoes', 'jacket', 'zara', 'h&m', '衣服', '鞋', '外套', '服飾'],
  'life.gifts': ['gift', 'present', 'birthday', 'wedding', '禮物', '生日', '紅包', '禮金', '婚禮'],
  'life.medical': ['pharmacy', 'medicine', 'doctor', 'hospital', 'clinic', 'cvs', 'walgreens', 'dental', '藥', '醫院', '診所', '看醫生', '牙醫', '藥局'],
  'life.education': ['tuition', 'course', 'class', 'book', 'books', '學費', '課程', '書'],
  'life.insurance': ['insurance', 'travel insurance', '保險', '旅平險'],
  'life.taxes': ['tax', 'visa fee', 'fee', 'tourist tax', '稅', '簽證', '規費', '手續費'],
};

function isAsciiWord(kw: string): boolean {
  return /^[a-z0-9&+.' -]+$/.test(kw);
}

/** Whole-word match for a Latin keyword, plural "s" / "es" allowed ("lift tickets", "taxes"). */
function wordPattern(kw: string): RegExp {
  return new RegExp('(^|[^a-z0-9])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:s|es)?($|[^a-z0-9])');
}

const KEYWORD_LIST: { kw: string; key: string; re: RegExp | null }[] = Object.entries(KEYWORDS)
  .flatMap(([key, kws]) => kws.map(kw => ({ kw, key, re: isAsciiWord(kw) ? wordPattern(kw) : null })))
  .sort((a, b) => b.kw.length - a.kw.length);

/**
 * Guess a category from a description ("燒肉晚餐" -> food.dining, "Uber to airport" ->
 * transport.taxi). Latin keywords must match whole words (a plural counts); Chinese keywords
 * match anywhere. The longest matching keyword wins. Returns null when nothing matches.
 */
export function detectCategory(description: string): string | null {
  const text = description.toLowerCase().normalize('NFKC');
  if (!text.trim()) return null;
  for (const { kw, key, re } of KEYWORD_LIST) {
    if (re ? re.test(text) : text.includes(kw)) return key;
  }
  return null;
}
