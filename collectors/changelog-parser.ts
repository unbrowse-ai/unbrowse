/**
 * Changelog Parser for Agent Experience Release Guide
 * 
 * Parses CHANGELOG.md to extract agent-focused changes and structure them
 * for narrative transformation.
 */

import { readFile } from 'fs/promises';
import { 
  ChangelogEntry, 
  ChangelogSection, 
  ChangelogItem, 
  CollectionConfig 
} from './types.js';

export class ChangelogParser {
  private config: CollectionConfig;

  constructor(config: CollectionConfig) {
    this.config = config;
  }

  async parseChangelog(filePath: string = 'CHANGELOG.md'): Promise<ChangelogEntry[]> {
    const content = await readFile(filePath, 'utf-8');
    return this.parseChangelogContent(content);
  }

  parseChangelogContent(content: string): ChangelogEntry[] {
    const lines = content.split('\n');
    const entries: ChangelogEntry[] = [];
    let currentEntry: ChangelogEntry | null = null;
    let currentSection: ChangelogSection | null = null;

    for (const line of lines) {
      // Match version headers: ## [6.7.0] or ## [Unreleased]
      const versionMatch = line.match(/^## \[([^\]]+)\](?:\([^)]*\))?\s*(?:\(([^)]+)\))?/);
      if (versionMatch) {
        // Save previous entry
        if (currentEntry) {
          entries.push(currentEntry);
        }

        const version = versionMatch[1];
        const date = versionMatch[2] || null;
        
        // Skip if not including prereleases
        if (!this.config.includePrerelease && version.includes('preview')) {
          currentEntry = null;
          continue;
        }

        currentEntry = {
          version,
          date,
          sections: []
        };
        currentSection = null;
        continue;
      }

      // Match section headers: ### Features, ### Bug Fixes, etc.
      const sectionMatch = line.match(/^### (.+)$/);
      if (sectionMatch && currentEntry) {
        const sectionType = sectionMatch[1] as ChangelogSection['type'];
        currentSection = {
          type: sectionType,
          items: []
        };
        currentEntry.sections.push(currentSection);
        continue;
      }

      // Match changelog items: * **scope:** description ([hash](url))
      const itemMatch = line.match(/^\* (?:\*\*([^*]+):\*\* )?(.+?)(?:\s+\(([a-f0-9]{7,})\)(?:\(([^)]+)\))?)?$/);
      if (itemMatch && currentSection) {
        const scope = itemMatch[1] || null;
        const description = itemMatch[2].replace(/\s+\([^)]*\)$/, ''); // Remove commit ref
        const commitHash = itemMatch[3] || null;
        const commitUrl = itemMatch[4] || null;

        const item: ChangelogItem = {
          scope,
          description,
          commitHash,
          commitUrl,
          agentRelevance: this.scoreAgentRelevance(scope, description)
        };

        currentSection.items.push(item);
      }
    }

    // Don't forget the last entry
    if (currentEntry) {
      entries.push(currentEntry);
    }

    return this.filterByTimeframe(entries);
  }

  /**
   * Score how relevant a change is to AI agents (0-1)
   */
  private scoreAgentRelevance(scope: string | null, description: string): number {
    let score = 0.3; // Base score

    // High relevance scopes
    const highRelevanceScopes = ['cli', 'mcp', 'api', 'sdk'];
    if (scope && highRelevanceScopes.includes(scope.toLowerCase())) {
      score += 0.4;
    }

    // Agent-relevant keywords
    const agentKeywords = [
      'agent', 'browser', 'cookies', 'fetch', 'resolve', 'execute',
      'marketplace', 'capture', 'sandbox', 'automation', 'harness'
    ];

    const descLower = description.toLowerCase();
    const keywordMatches = agentKeywords.filter(keyword => 
      descLower.includes(keyword)
    ).length;

    score += keywordMatches * 0.1;

    // Specific high-value phrases
    const highValuePhrases = [
      'unbrowse fetch',
      '--use-browser-cookies',
      'marketplace flywheel',
      'auto-converts html',
      'agent-simple'
    ];

    if (highValuePhrases.some(phrase => descLower.includes(phrase.toLowerCase()))) {
      score += 0.3;
    }

    return Math.min(score, 1.0);
  }

  private filterByTimeframe(entries: ChangelogEntry[]): ChangelogEntry[] {
    if (this.config.timeframeDays === 0) {
      return entries;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.timeframeDays);

    return entries.filter(entry => {
      if (!entry.date) return true; // Include undated entries (like Unreleased)
      
      try {
        const entryDate = new Date(entry.date);
        return entryDate >= cutoffDate;
      } catch {
        return true; // Include entries with unparseable dates
      }
    });
  }

  /**
   * Example transformation: Extract major agent-focused features
   */
  extractAgentHighlights(entries: ChangelogEntry[]): Array<{
    version: string;
    feature: string;
    agentBenefit: string;
  }> {
    const highlights: Array<{
      version: string;
      feature: string;
      agentBenefit: string;
    }> = [];

    for (const entry of entries) {
      for (const section of entry.sections) {
        if (section.type === 'Features') {
          for (const item of section.items) {
            if (item.agentRelevance >= this.config.agentRelevanceThreshold) {
              highlights.push({
                version: entry.version,
                feature: item.description,
                agentBenefit: this.generateAgentBenefit(item)
              });
            }
          }
        }
      }
    }

    return highlights;
  }

  private generateAgentBenefit(item: ChangelogItem): string {
    const desc = item.description.toLowerCase();
    
    if (desc.includes('fetch')) {
      return 'Agents can now get page content with a single command';
    }
    if (desc.includes('cookies')) {
      return 'Agents can access authenticated pages using real browser sessions';
    }
    if (desc.includes('marketplace')) {
      return 'Agents automatically contribute to the shared skill marketplace';
    }
    if (desc.includes('markdown')) {
      return 'Agents receive clean, token-efficient content instead of raw HTML';
    }
    
    return 'Improves agent workflow and developer experience';
  }
}