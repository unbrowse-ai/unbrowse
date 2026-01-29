import { useState, useEffect, useCallback } from 'react';
import { Hero } from '../components/Hero';
import { CategoryFilter } from '../components/CategoryFilter';
import { SkillCard, SkillCardSkeleton } from '../components/SkillCard';
import { Leaderboard } from '../components/Leaderboard';
import { searchSkills, getCategories, type Skill } from '../lib/api';

export function Home() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [categories, setCategories] = useState<string[]>(['all']);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load categories on mount
  useEffect(() => {
    getCategories().then(setCategories).catch(console.error);
  }, []);

  // Debounced search
  const performSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await searchSkills(searchQuery, activeCategory);
      setSkills(result.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, activeCategory]);

  useEffect(() => {
    const timer = setTimeout(performSearch, 300);
    return () => clearTimeout(timer);
  }, [performSearch]);

  return (
    <main className="main-content">
      <Hero searchQuery={searchQuery} onSearchChange={setSearchQuery} />

      <div className="container">
        <CategoryFilter
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
        />

        <section className="skill-grid-section">
          <div>
            {error && (
              <div className="empty-state">
                <div className="empty-state-icon">⚠️</div>
                <h3 className="empty-state-title">Something went wrong</h3>
                <p className="empty-state-description">{error}</p>
              </div>
            )}

            {!error && loading && (
              <div className="skill-grid">
                {[...Array(6)].map((_, i) => (
                  <SkillCardSkeleton key={i} />
                ))}
              </div>
            )}

            {!error && !loading && skills.length === 0 && (
              <div className="empty-state">
                <div className="empty-state-icon">🔍</div>
                <h3 className="empty-state-title">No skills found</h3>
                <p className="empty-state-description">
                  {searchQuery
                    ? `No skills match "${searchQuery}". Try a different search term.`
                    : 'No skills available in this category yet.'}
                </p>
              </div>
            )}

            {!error && !loading && skills.length > 0 && (
              <div className="skill-grid">
                {skills.map((skill, index) => (
                  <div
                    key={skill.id}
                    className="animate-fadeInUp"
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <SkillCard skill={skill} />
                  </div>
                ))}
              </div>
            )}
          </div>

          <Leaderboard />
        </section>
      </div>
    </main>
  );
}
