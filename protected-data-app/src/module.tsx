import { AppPlugin } from '@grafana/data';
import OnboardingPage from './OnboardingPage';

export const plugin = new AppPlugin().setRootPage(OnboardingPage);
