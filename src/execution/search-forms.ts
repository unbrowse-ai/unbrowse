export interface SearchFormField {
  name: string;
  type: "text" | "select" | "radio" | "checkbox" | "date" | "hidden";
  selector: string;
  options?: string[];
  required: boolean;
}

export interface SearchFormSpec {
  form_selector: string;
  submit_selector: string;
  fields: SearchFormField[];
  result_selector?: string;
}

export function isStructuredSearchForm(spec: SearchFormSpec): boolean {
  return spec.fields.length > 0 && !!spec.submit_selector;
}
