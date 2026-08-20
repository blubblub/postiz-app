import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class CommentHideTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'commentHide';

  run() {
    return createTool({
      id: 'commentHide',
      description: `Hide or unhide someone else's comment on a published post. Hiding takes the comment out of public view on the platform; it is reversible by calling this again with hidden=false. Use commentList first to get the comment id and to see whether it is already hidden.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('Channel id from the integrationList tool'),
        postId: z.string().describe('Post id from the commentPostList tool'),
        commentId: z.string().describe('Comment id from the commentList tool'),
        hidden: z
          .boolean()
          .describe('true hides the comment, false makes it public again'),
      }),
      mcp: {
        annotations: {
          title: 'Hide Or Unhide A Comment',
          // Changes what the public sees on a real social account.
          readOnlyHint: false,
          // Reversible: calling again with hidden=false restores it.
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      outputSchema: z.object({
        id: z.string(),
        hidden: z.boolean(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        return this._integrationService.hideComment(
          organizationId,
          inputData.integrationId,
          inputData.postId,
          inputData.commentId,
          inputData.hidden
        );
      },
    });
  }
}
