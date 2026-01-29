interface CategoryFilterProps {
  categories: string[];
  activeCategory: string;
  onCategoryChange: (category: string) => void;
}

const categoryLabels: Record<string, string> = {
  all: 'All Skills',
  ecommerce: 'E-Commerce',
  social: 'Social Media',
  productivity: 'Productivity',
  finance: 'Finance',
  travel: 'Travel & Booking',
  developer: 'Developer Tools',
  entertainment: 'Entertainment',
};

const categoryIcons: Record<string, string> = {
  all: '🌐',
  ecommerce: '🛒',
  social: '💬',
  productivity: '⚡',
  finance: '💰',
  travel: '✈️',
  developer: '👨‍💻',
  entertainment: '🎮',
};

export function CategoryFilter({
  categories,
  activeCategory,
  onCategoryChange,
}: CategoryFilterProps) {
  return (
    <div className="category-filter">
      {categories.map((category) => (
        <button
          key={category}
          className={`category-pill ${
            activeCategory === category ? 'category-pill-active' : ''
          }`}
          onClick={() => onCategoryChange(category)}
        >
          <span>{categoryIcons[category] || '📁'}</span>
          <span>{categoryLabels[category] || category}</span>
        </button>
      ))}
    </div>
  );
}
