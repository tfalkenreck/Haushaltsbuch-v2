import { UncategorizedBanner } from './components/UncategorizedBanner';
import { AccountsPage } from './pages/AccountsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { ImportPage } from './pages/ImportPage';
import { RulesPage } from './pages/RulesPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { TransfersPage } from './pages/TransfersPage';
import { hrefFor, useRoute, type Page } from './lib/route';

const NAV: { page: Page; label: string }[] = [
  { page: 'konten', label: 'Konten' },
  { page: 'import', label: 'Import' },
  { page: 'buchungen', label: 'Buchungen' },
  { page: 'umbuchungen', label: 'Umbuchungen' },
  { page: 'kategorien', label: 'Kategorien' },
  { page: 'regeln', label: 'Regeln' },
];

export function App() {
  const route = useRoute();

  return (
    <main>
      <header className="app-header">
        <h1>Haushaltsbuch</h1>
        <nav>
          {NAV.map((item) => (
            <a key={item.page} href={hrefFor(item.page)} className={route.page === item.page ? 'active' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      <UncategorizedBanner routeKey={`${route.page}?${route.params.toString()}`} />
      {route.page === 'konten' && <AccountsPage />}
      {route.page === 'import' && <ImportPage params={route.params} />}
      {route.page === 'buchungen' && <TransactionsPage params={route.params} />}
      {route.page === 'umbuchungen' && <TransfersPage params={route.params} />}
      {route.page === 'kategorien' && <CategoriesPage />}
      {route.page === 'regeln' && <RulesPage />}
    </main>
  );
}
