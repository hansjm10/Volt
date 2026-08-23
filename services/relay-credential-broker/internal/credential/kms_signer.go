package credential

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"hash/crc32"
	"strconv"
	"strings"
	"time"

	kms "cloud.google.com/go/kms/apiv1"
	"cloud.google.com/go/kms/apiv1/kmspb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

const (
	maxKMSKeyVersionNameBytes = 1024
	kmsSignTimeout            = 5 * time.Second
	kmsReadinessChallengeSize = 32
	kmsReadinessDomain        = "volt-relay-credential-kms-readiness-v1\x00"
)

var crc32cTable = crc32.MakeTable(crc32.Castagnoli)

type keyManagementClient interface {
	GetPublicKey(ctx context.Context, name string) (*kmspb.PublicKey, error)
	AsymmetricSign(ctx context.Context, request *kmspb.AsymmetricSignRequest) (*kmspb.AsymmetricSignResponse, error)
	Close() error
}

type googleKMSClient struct {
	client *kms.KeyManagementClient
}

func (c *googleKMSClient) GetPublicKey(ctx context.Context, name string) (*kmspb.PublicKey, error) {
	return c.client.GetPublicKey(ctx, &kmspb.GetPublicKeyRequest{Name: name})
}

func (c *googleKMSClient) AsymmetricSign(
	ctx context.Context,
	request *kmspb.AsymmetricSignRequest,
) (*kmspb.AsymmetricSignResponse, error) {
	return c.client.AsymmetricSign(ctx, request)
}

func (c *googleKMSClient) Close() error {
	return c.client.Close()
}

type kmsSignatureProvider struct {
	client         keyManagementClient
	keyVersionName string
}

func (p *kmsSignatureProvider) Sign(ctx context.Context, message []byte) ([]byte, error) {
	signContext, cancel := context.WithTimeout(ctx, kmsSignTimeout)
	defer cancel()
	response, err := p.client.AsymmetricSign(signContext, &kmspb.AsymmetricSignRequest{
		Name:       p.keyVersionName,
		Data:       message,
		DataCrc32C: wrapperspb.Int64(int64(crc32.Checksum(message, crc32cTable))),
	})
	if err != nil {
		return nil, fmt.Errorf("Cloud KMS asymmetric sign: %w", err)
	}
	if response == nil || response.Name != p.keyVersionName || !response.VerifiedDataCrc32C {
		return nil, errors.New("Cloud KMS signing response failed request integrity verification")
	}
	if len(response.Signature) != ed25519.SignatureSize || response.SignatureCrc32C == nil || response.SignatureCrc32C.Value != int64(crc32.Checksum(response.Signature, crc32cTable)) {
		return nil, errors.New("Cloud KMS signing response has an invalid signature checksum")
	}
	return append([]byte(nil), response.Signature...), nil
}

func NewKMSSigner(
	ctx context.Context,
	issuer string,
	audience string,
	activeKeyVersion string,
	retiringKeyVersions []string,
) (*Signer, error) {
	if ctx == nil {
		return nil, errors.New("Cloud KMS initialization context is required")
	}
	client, err := kms.NewKeyManagementClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("create Cloud KMS client: %w", err)
	}
	return newKMSSignerWithClient(
		ctx,
		issuer,
		audience,
		activeKeyVersion,
		retiringKeyVersions,
		&googleKMSClient{client: client},
	)
}

func newKMSSignerWithClient(
	ctx context.Context,
	issuer string,
	audience string,
	activeKeyVersion string,
	retiringKeyVersions []string,
	client keyManagementClient,
) (*Signer, error) {
	if client == nil {
		return nil, errors.New("Cloud KMS client is required")
	}
	initialized := false
	defer func() {
		if !initialized {
			_ = client.Close()
		}
	}()
	if ctx == nil {
		return nil, errors.New("Cloud KMS initialization context is required")
	}
	if len(retiringKeyVersions)+1 > maxVerificationKeys {
		return nil, fmt.Errorf("at most %d active and retiring Cloud KMS key versions are allowed", maxVerificationKeys)
	}
	keyVersions := make([]string, 0, len(retiringKeyVersions)+1)
	keyVersions = append(keyVersions, activeKeyVersion)
	keyVersions = append(keyVersions, retiringKeyVersions...)
	activeParent, activeVersion, ok := parseKMSKeyVersionName(activeKeyVersion)
	if !ok {
		return nil, fmt.Errorf("Cloud KMS key version resource name is invalid: %q", activeKeyVersion)
	}
	seenVersions := map[string]struct{}{activeKeyVersion: {}}
	for _, name := range retiringKeyVersions {
		parent, version, ok := parseKMSKeyVersionName(name)
		if !ok {
			return nil, fmt.Errorf("Cloud KMS key version resource name is invalid: %q", name)
		}
		if _, exists := seenVersions[name]; exists {
			return nil, errors.New("active and retiring Cloud KMS key versions must be unique")
		}
		if parent != activeParent {
			return nil, errors.New("active and retiring Cloud KMS versions must belong to the same CryptoKey")
		}
		if version >= activeVersion {
			return nil, errors.New("active Cloud KMS version must be newer than every retiring version")
		}
		seenVersions[name] = struct{}{}
	}

	publicKeys := make([]ed25519.PublicKey, 0, len(keyVersions))
	for _, name := range keyVersions {
		public, err := loadKMSPublicKey(ctx, client, name)
		if err != nil {
			return nil, err
		}
		publicKeys = append(publicKeys, public)
	}
	provider := &kmsSignatureProvider{client: client, keyVersionName: activeKeyVersion}
	challenge := make([]byte, len(kmsReadinessDomain)+kmsReadinessChallengeSize)
	copy(challenge, kmsReadinessDomain)
	if _, err := rand.Read(challenge[len(kmsReadinessDomain):]); err != nil {
		return nil, fmt.Errorf("generate Cloud KMS readiness challenge: %w", err)
	}
	signature, err := provider.Sign(ctx, challenge)
	if err != nil {
		return nil, fmt.Errorf("verify active Cloud KMS signing capability: %w", err)
	}
	if !ed25519.Verify(publicKeys[0], challenge, signature) {
		return nil, errors.New("active Cloud KMS key failed readiness signature verification")
	}

	signer, err := newSigner(
		issuer,
		audience,
		provider,
		publicKeys[0],
		publicKeys[1:],
		client.Close,
	)
	if err != nil {
		return nil, err
	}
	initialized = true
	return signer, nil
}

func loadKMSPublicKey(
	ctx context.Context,
	client keyManagementClient,
	keyVersionName string,
) (ed25519.PublicKey, error) {
	response, err := client.GetPublicKey(ctx, keyVersionName)
	if err != nil {
		return nil, fmt.Errorf("get Cloud KMS public key %q: %w", keyVersionName, err)
	}
	if response == nil || response.Name != keyVersionName {
		return nil, fmt.Errorf("Cloud KMS public key %q failed resource integrity verification", keyVersionName)
	}
	if response.Algorithm != kmspb.CryptoKeyVersion_EC_SIGN_ED25519 {
		return nil, fmt.Errorf("Cloud KMS key version %q must use EC_SIGN_ED25519", keyVersionName)
	}
	pemBytes := []byte(response.Pem)
	if response.PemCrc32C == nil || response.PemCrc32C.Value != int64(crc32.Checksum(pemBytes, crc32cTable)) {
		return nil, fmt.Errorf("Cloud KMS public key %q failed checksum verification", keyVersionName)
	}
	block, rest := pem.Decode(pemBytes)
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, fmt.Errorf("Cloud KMS public key %q is not one PKIX public key", keyVersionName)
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse Cloud KMS public key %q: %w", keyVersionName, err)
	}
	public, ok := parsed.(ed25519.PublicKey)
	if !ok || len(public) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("Cloud KMS public key %q is not Ed25519", keyVersionName)
	}
	return append(ed25519.PublicKey(nil), public...), nil
}

func parseKMSKeyVersionName(name string) (string, uint64, bool) {
	if name == "" || len(name) > maxKMSKeyVersionNameBytes || name != strings.TrimSpace(name) || strings.ContainsFunc(name, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	}) {
		return "", 0, false
	}
	parts := strings.Split(name, "/")
	if len(parts) != 10 || parts[0] != "projects" || parts[2] != "locations" || parts[4] != "keyRings" || parts[6] != "cryptoKeys" || parts[8] != "cryptoKeyVersions" {
		return "", 0, false
	}
	for _, index := range []int{1, 3, 5, 7} {
		if parts[index] == "" || len(parts[index]) > 128 {
			return "", 0, false
		}
	}
	version, err := strconv.ParseUint(parts[9], 10, 64)
	if err != nil || version == 0 || strconv.FormatUint(version, 10) != parts[9] {
		return "", 0, false
	}
	return strings.Join(parts[:9], "/"), version, true
}
