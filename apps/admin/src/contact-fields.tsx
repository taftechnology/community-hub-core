import { Field, Input } from "@community-hub/ui";

export type ContactFormData = {
  givenName: string;
  familyName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
};

export const initialFormData: ContactFormData = {
  givenName: "",
  familyName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
};

export function ContactFields({
  prefix,
  data,
  onChange,
  dobHelp,
}: {
  prefix: string;
  data: ContactFormData;
  onChange: (data: ContactFormData) => void;
  dobHelp?: string;
}) {
  return (
    <>
      <Field label="Given name">
        <Input
          id={`${prefix}-given-name`}
          value={data.givenName}
          onChange={(e) => onChange({ ...data, givenName: e.target.value })}
          required
        />
      </Field>
      <Field label="Family name">
        <Input
          id={`${prefix}-family-name`}
          value={data.familyName}
          onChange={(e) => onChange({ ...data, familyName: e.target.value })}
          required
        />
      </Field>
      <Field label="Email">
        <Input
          id={`${prefix}-email`}
          type="email"
          value={data.email}
          onChange={(e) => onChange({ ...data, email: e.target.value })}
        />
      </Field>
      <Field label="Phone">
        <Input
          id={`${prefix}-phone`}
          type="tel"
          value={data.phone}
          onChange={(e) => onChange({ ...data, phone: e.target.value })}
        />
      </Field>
      <Field label="Date of birth" {...(dobHelp !== undefined ? { help: dobHelp } : {})}>
        <Input
          id={`${prefix}-dob`}
          type="date"
          value={data.dateOfBirth}
          onChange={(e) => onChange({ ...data, dateOfBirth: e.target.value })}
        />
      </Field>
    </>
  );
}
