import SwiftUI

/// Small always-on-top dark/high-contrast draft window.
public struct OverlayView: View {
    @ObservedObject var controller: OverlayController
    @FocusState private var editorFocused: Bool

    public init(controller: OverlayController) {
        self.controller = controller
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            contextLabels
            editor
            nameField
            statusStrip
            controls
        }
        .padding(14)
        .frame(minWidth: 520, idealWidth: 560, minHeight: 360, idealHeight: 420)
        .background(Color(red: 0.04, green: 0.05, blue: 0.06))
        .preferredColorScheme(.dark)
        .onAppear {
            editorFocused = true
            controller.focusWindow()
        }
    }

    private var header: some View {
        HStack {
            Text("ORCA DRAFT")
                .font(.system(size: 20, weight: .bold, design: .monospaced))
                .foregroundStyle(Color(red: 0.95, green: 0.96, blue: 0.97))
            Spacer()
            Text(controller.uiState.rawValue.uppercased())
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(stateColor)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color(red: 0.07, green: 0.08, blue: 0.10))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }

    private var contextLabels: some View {
        VStack(alignment: .leading, spacing: 2) {
            labelRow("repo", controller.context.repoLabel)
            labelRow("worktree", controller.context.worktreeLabel)
            labelRow("host", controller.context.hostLabel)
            labelRow("agent", controller.context.agentLabel)
        }
        .font(.system(size: 15, weight: .medium, design: .monospaced))
        .foregroundStyle(Color(red: 0.60, green: 0.64, blue: 0.69))
    }

    private func labelRow(_ key: String, _ value: String?) -> some View {
        HStack(spacing: 6) {
            Text(key.uppercased())
                .frame(width: 72, alignment: .leading)
            Text(value?.isEmpty == false ? value! : "—")
                .foregroundStyle(Color(red: 0.95, green: 0.96, blue: 0.97))
                .lineLimit(1)
            Spacer()
        }
    }

    private var editor: some View {
        TextEditor(text: Binding(
            get: { controller.editorText },
            set: { controller.onEditorChange($0) }
        ))
        .font(.system(size: 17, design: .monospaced))
        .scrollContentBackground(.hidden)
        .padding(8)
        .frame(minHeight: 140)
        .background(Color(red: 0.07, green: 0.08, blue: 0.10))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(red: 0.16, green: 0.19, blue: 0.24), lineWidth: 1)
        )
        .focused($editorFocused)
        .disabled(controller.uiState == .submitting)
    }

    private var nameField: some View {
        HStack(spacing: 8) {
            Text("NAME")
                .font(.system(size: 15, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color(red: 0.60, green: 0.64, blue: 0.69))
                .frame(width: 48, alignment: .leading)
            TextField("worktree-name", text: Binding(
                get: { controller.nameText },
                set: { controller.onNameChange($0) }
            ))
            .textFieldStyle(.plain)
            .font(.system(size: 17, design: .monospaced))
            .padding(8)
            .background(Color(red: 0.07, green: 0.08, blue: 0.10))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .disabled(controller.uiState == .submitting)
        }
    }

    private var statusStrip: some View {
        Text(controller.statusMessage.isEmpty ? " " : controller.statusMessage)
            .font(.system(size: 15, weight: .medium, design: .monospaced))
            .foregroundStyle(controller.statusIsError
                ? Color(red: 0.94, green: 0.27, blue: 0.22)
                : Color(red: 0.60, green: 0.64, blue: 0.69))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                actionButton("Import Clipboard", enabled: controller.uiState != .submitting) {
                    controller.importClipboard()
                }
                actionButton("Dictate", enabled: controller.uiState != .submitting) {
                    controller.dictate()
                }
                Spacer()
                actionButton("Clear", enabled: controller.uiState != .submitting) {
                    controller.clear()
                }
                actionButton("Cancel", enabled: true) {
                    controller.cancel()
                }
            }
            HStack(spacing: 8) {
                actionButton("Send to Selected", emphasized: true, enabled: controller.canSubmit) {
                    controller.sendSelected()
                }
                actionButton("New OMP", enabled: controller.canSubmit) {
                    controller.launch(provider: .omp)
                }
                actionButton("New Claude", enabled: controller.canSubmit) {
                    controller.launch(provider: .claude)
                }
                actionButton("New Codex", enabled: controller.canSubmit) {
                    controller.launch(provider: .codex)
                }
            }
        }
    }

    private func actionButton(
        _ title: String,
        emphasized: Bool = false,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17, weight: .semibold, design: .monospaced))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity)
                .background(
                    enabled
                        ? (emphasized
                            ? Color(red: 0.23, green: 0.51, blue: 0.96)
                            : Color(red: 0.12, green: 0.15, blue: 0.18))
                        : Color(red: 0.08, green: 0.09, blue: 0.11)
                )
                .foregroundStyle(enabled
                    ? Color(red: 0.95, green: 0.96, blue: 0.97)
                    : Color(red: 0.42, green: 0.45, blue: 0.50))
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var stateColor: Color {
        switch controller.uiState {
        case .empty: return Color(red: 0.42, green: 0.45, blue: 0.50)
        case .editing: return Color(red: 0.23, green: 0.51, blue: 0.96)
        case .ready: return Color(red: 0.13, green: 0.77, blue: 0.37)
        case .submitting: return Color(red: 0.96, green: 0.65, blue: 0.14)
        }
    }
}
