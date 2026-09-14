import { render, screen } from '@testing-library/react'; import { expect,test } from 'vitest'; import { App } from '../../web/App';
test('renders the MarkTV application shell',()=>{render(<App/>);expect(screen.getByRole('heading',{name:'MarkTV'})).toBeVisible();expect(screen.getByRole('navigation')).toBeVisible();});
