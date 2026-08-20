import { IntegrationValidationTool } from '@gitroom/nestjs-libraries/chat/tools/integration.validation.tool';
import { IntegrationTriggerTool } from '@gitroom/nestjs-libraries/chat/tools/integration.trigger.tool';
import { IntegrationSchedulePostTool } from './integration.schedule.post';
import { GenerateVideoOptionsTool } from '@gitroom/nestjs-libraries/chat/tools/generate.video.options.tool';
import { VideoFunctionTool } from '@gitroom/nestjs-libraries/chat/tools/video.function.tool';
import { GenerateVideoTool } from '@gitroom/nestjs-libraries/chat/tools/generate.video.tool';
import { GenerateImageTool } from '@gitroom/nestjs-libraries/chat/tools/generate.image.tool';
import { IntegrationListTool } from '@gitroom/nestjs-libraries/chat/tools/integration.list.tool';
import { GroupListTool } from '@gitroom/nestjs-libraries/chat/tools/group.list.tool';
import { UploadFromUrlTool } from '@gitroom/nestjs-libraries/chat/tools/upload.from.url.tool';
import { CommentPostListTool } from '@gitroom/nestjs-libraries/chat/tools/comment.post.list.tool';
import { CommentListTool } from '@gitroom/nestjs-libraries/chat/tools/comment.list.tool';
import { CommentReplyTool } from '@gitroom/nestjs-libraries/chat/tools/comment.reply.tool';
import { CommentHideTool } from '@gitroom/nestjs-libraries/chat/tools/comment.hide.tool';
import { PostListTool } from '@gitroom/nestjs-libraries/chat/tools/post.list.tool';
import { PostDeleteTool } from '@gitroom/nestjs-libraries/chat/tools/post.delete.tool';
import { NotificationListTool } from '@gitroom/nestjs-libraries/chat/tools/notification.list.tool';
import { ChannelAnalyticsTool } from '@gitroom/nestjs-libraries/chat/tools/channel.analytics.tool';

export const toolList = [
  IntegrationListTool,
  GroupListTool,
  IntegrationValidationTool,
  IntegrationTriggerTool,
  IntegrationSchedulePostTool,
  GenerateVideoOptionsTool,
  VideoFunctionTool,
  GenerateVideoTool,
  GenerateImageTool,
  UploadFromUrlTool,
  CommentPostListTool,
  CommentListTool,
  CommentReplyTool,
  CommentHideTool,
  PostListTool,
  PostDeleteTool,
  NotificationListTool,
  ChannelAnalyticsTool,
];
