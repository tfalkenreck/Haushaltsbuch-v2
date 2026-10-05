import { UncategorizedBanner } from './components/UncategorizedBanner';
import { AccountsPage } from './pages/AccountsPage';
import { BudgetPage } from './pages/BudgetPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { ForecastPage } from './pages/ForecastPage';
import { FundingPage } from './pages/FundingPage';
import { ImportPage } from './pages/ImportPage';
import { OverviewPage } from './pages/OverviewPage';
import { RecurringPage } from './pages/RecurringPage';
import { RulesPage } from './pages/RulesPage';
import { SavingsGoalsPage } from './pages/SavingsGoalsPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { TransfersPage } from './pages/TransfersPage';
import { hrefFor, useRoute, type Page } from './lib/route';

const NAV: { page: Page; label: string }[] = [
  { page: 'uebersicht', label: 'Übersicht' },
  { page: 'konten', label: 'Konten' },
  { page: 'import', label: 'Import' },
  { page: 'buchungen', label: 'Buchungen' },
  { page: 'umbuchungen', label: 'Umbuchungen' },
  { page: 'deckung', label: 'Deckung' },
  { page: 'fixkosten', label: 'Fixkosten & Abos' },
  { page: 'budget', label: 'Budget' },
  { page: 'prognose', label: 'Prognose' },
  { page: 'sparziele', label: 'Sparziele' },
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
      {route.page === 'uebersicht' && <OverviewPage params={route.params} />}
      {route.page === 'konten' && <AccountsPage />}
      {route.page === 'import' && <ImportPage params={route.params} />}
      {route.page === 'buchungen' && <TransactionsPage params={route.params} />}
      {route.page === 'umbuchungen' && <TransfersPage params={route.params} />}
      {route.page === 'deckung' && <FundingPage params={route.params} />}
      {route.page === 'fixkosten' && <RecurringPage params={route.params} />}
      {route.page === 'budget' && <BudgetPage params={route.params} />}
      {route.page === 'prognose' && <ForecastPage params={route.params} />}
      {route.page === 'sparziele' && <SavingsGoalsPage />}
      {route.page === 'kategorien' && <CategoriesPage />}
      {route.page === 'regeln' && <RulesPage />}
    </main>
  );
}
