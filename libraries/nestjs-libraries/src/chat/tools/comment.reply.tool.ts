import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import z from 'zod';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { organizationFromContext } from '@gitroom/nestjs-libraries/chat/tools/comment.context';

@Injectable()
export class CommentReplyTool implements AgentToolInterface {
  constructor(private _integrationService: IntegrationService) {}
  name = 'commentReply';

  run() {
    return createTool({
      id: 'commentReply',
      description: `Publicly reply to a comment as the channel. The reply is posted immediately on the real social account under the brand's name and cannot be withdrawn from here, so confirm the wording with the user before calling this. Use commentList first to get the comment id.`,
      inputSchema: z.object({
        integrationId: z
          .string()
          .describe('Channel id from the integrationList tool'),
        postId: z.string().describe('Post id from the commentPostList tool'),
        commentId: z
          .string()
          .describe('Id of the comment being replied to, from commentList'),
        message: z
          .string()
          .describe(
            'The reply text. Platforms cap this — TikTok allows 150 characters.'
          ),
      }),
      mcp: {
        annotations: {
          title: 'Reply To A Comment',
          readOnlyHint: false,
          // Publishes under the customer's brand and can't be undone here.
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      outputSchema: z.object({
        id: z.string(),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = organizationFromContext(context);

        return this._integrationService.replyToComment(
          organizationId,
          inputData.integrationId,
          inputData.postId,
          inputData.commentId,
          inputData.message
        );
      },
    });
  }
}
