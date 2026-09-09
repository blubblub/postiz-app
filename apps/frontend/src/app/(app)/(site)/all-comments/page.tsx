export const dynamic = 'force-dynamic';

import { Metadata } from 'next';
import { AllComments } from '@gitroom/frontend/components/comments/all.comments';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} All comments`,
  description: '',
};

export default async function Index() {
  return <AllComments />;
}
