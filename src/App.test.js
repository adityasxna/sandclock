import { render, screen } from '@testing-library/react';
import App from './App';

test('renders landing guest name prompt', () => {
  render(<App />);
  expect(screen.getByText(/guest name/i)).toBeInTheDocument();
});
