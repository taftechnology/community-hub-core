export interface InvitationMail {
  send(input: { to: string; communitySlug: string; link: string; expiresAt: Date }): Promise<void>;
}

export class InvitationMailUnavailable extends Error {
  constructor(message = "invitation_mail_unavailable") {
    super(message);
    this.name = "InvitationMailUnavailable";
  }
}

export const rejectingInvitationMail: InvitationMail = {
  send() {
    return Promise.reject(new InvitationMailUnavailable());
  },
};
