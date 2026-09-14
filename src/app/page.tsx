import { redirect } from 'next/navigation';

import { currentPersona, homeFor } from './session';

/** Land each persona on their own first screen. */
export default async function Home() {
  redirect(homeFor(await currentPersona()));
}
